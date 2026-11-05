package io.zooglass.runtime;

import io.zooglass.strategy.progress.ProgressStrategySelection;

import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Refuses incompatible definitions and inconsistent recovered metadata before readiness. */
final class RecoveryValidation {

    private RecoveryValidation() {}

    static void configuration(RuntimeConfiguration previous, RuntimeConfiguration requested) {
        previous.validate();
        if (!"sqlite".equals(previous.storage())
                || previous.maxStreams() != requested.maxStreams()
                || previous.identityWindow() != requested.identityWindow()
                || previous.maxHistoryEntries() != requested.maxHistoryEntries()
                || !requested.sources().containsAll(previous.sources())
                || !requested.views().containsAll(previous.views())) {
            throw new IllegalStateException(
                    "Stored configuration conflicts with startup configuration");
        }
    }

    static void image(StateImage image, RuntimeConfiguration configuration) {
        Map<String, String> epochs =
                configuration.sources().stream()
                        .collect(
                                Collectors.toMap(
                                        RuntimeConfiguration.Source::id,
                                        RuntimeConfiguration.Source::epoch));
        var sourceDefinitions =
                configuration.sources().stream()
                        .collect(
                                Collectors.toMap(
                                        RuntimeConfiguration.Source::id, Function.identity()));
        var definitions =
                configuration.views().stream()
                        .collect(
                                Collectors.toMap(
                                        RuntimeConfiguration.View::id, Function.identity()));

        require(image.version() >= 0 && image.streams().size() <= configuration.maxStreams());
        for (var entry : image.streams().entrySet()) {
            var key = entry.getKey();
            var stream = entry.getValue();
            require(
                    key.epoch().equals(epochs.get(key.sourceId()))
                            && !key.sourceEntityId().isBlank());
            require(stream.floor() >= 1 && stream.floor() <= PublicationJson.MAX_SEQUENCE);
            var settings = sourceDefinitions.get(key.sourceId()).progress();
            var policy =
                    ProgressStrategySelection.select(
                            settings.mode(),
                            settings.startSequence(),
                            settings.maxReceivedRanges(),
                            settings.maxMissingRanges());
            policy.validate(stream.progress(), stream.floor(), image.version());
            if (stream.reservationOnly()) {
                require(
                        stream.floor() == 1
                                && stream.receipts().isEmpty()
                                && java.util.Objects.equals(stream.progress(), policy.initial())
                                && FactRecovery.owns(image, key));
            }
            require(
                    stream.receipts() != null
                            && (!stream.receipts().isEmpty()
                                    || (stream.progress() != null
                                            && stream.progress().watermarkThrough() != null)
                                    || FactRecovery.owns(image, key))
                            && stream.receipts().size() <= configuration.identityWindow());
            for (var receipt : stream.receipts().entrySet()) {
                require(
                        receipt.getKey() <= PublicationJson.MAX_SEQUENCE
                                && receipt.getKey() >= stream.floor()
                                && receipt.getKey() - stream.floor()
                                        < configuration.identityWindow());
                if (stream.progress() != null) {
                    require(
                            receipt.getKey() >= settings.startSequence()
                                    && ViewRecovery.received(stream.progress(), receipt.getKey()));
                }
                var value = receipt.getValue();
                require(
                        value != null
                                && value.version() > 0
                                && value.version() <= image.version()
                                && value.type() != null
                                && !value.type().isBlank()
                                && value.content() != null
                                && value.content().isObject());
                if (value.fact() != null) {
                    value.fact().validate(receipt.getKey(), value.content());
                }
                if (value.targets() != null) {
                    TargetRecovery.validate(value.targets(), key, value.type(), definitions);
                    boolean rejectedLate =
                            value.targets().stream()
                                    .filter(target -> target.fields() != null)
                                    .flatMap(target -> target.fields().stream())
                                    .anyMatch(field -> "behindWatermark".equals(field.reason()));
                    if (rejectedLate) {
                        require(
                                stream.progress() != null
                                        && stream.progress().sourceContractViolated()
                                        && stream.progress().watermarkThrough() != null
                                        && receipt.getKey()
                                                <= stream.progress().watermarkThrough());
                    }
                }
            }
        }
        ViewRecovery.validate(image, configuration, epochs, definitions, sourceDefinitions);
        FactRecovery.validate(image, configuration);
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new IllegalStateException("Invalid recovered state");
        }
    }
}
