package io.zooglass.v2;

import io.zooglass.strategy.identity.EntityStrategySelection;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Refuses incompatible definitions and inconsistent recovered metadata before readiness. */
final class RecoveryValidation {
    private RecoveryValidation() {}

    static void configuration(V2Configuration previous, V2Configuration requested) {
        previous.validate();
        if (!"sqlite".equals(previous.storage())
                || previous.maxStreams() != requested.maxStreams()
                || previous.identityWindow() != requested.identityWindow()
                || previous.maxHistoryEntries() != requested.maxHistoryEntries()
                || !requested.sources().containsAll(previous.sources())
                || !requested.views().containsAll(previous.views())) {
            throw new IllegalStateException("Stored v2 configuration conflicts with startup configuration");
        }
    }

    static void image(StateImage image, V2Configuration configuration) {
        Map<String, String> epochs = configuration.sources().stream()
                .collect(Collectors.toMap(V2Configuration.Source::id, V2Configuration.Source::epoch));
        var definitions = configuration.views().stream()
                .collect(Collectors.toMap(V2Configuration.View::id, Function.identity()));

        require(image.version() >= 0 && image.streams().size() <= configuration.maxStreams());
        for (var entry : image.streams().entrySet()) {
            var key = entry.getKey();
            var stream = entry.getValue();
            require(key.epoch().equals(epochs.get(key.sourceId())) && !key.sourceEntityId().isBlank());
            require(stream.floor() >= 1 && stream.floor() <= PublicationJson.MAX_SEQUENCE);
            require(stream.receipts() != null && !stream.receipts().isEmpty()
                    && stream.receipts().size() <= configuration.identityWindow());
            for (var receipt : stream.receipts().entrySet()) {
                require(receipt.getKey() <= PublicationJson.MAX_SEQUENCE && receipt.getKey() >= stream.floor()
                        && receipt.getKey() - stream.floor() < configuration.identityWindow());
                var value = receipt.getValue();
                require(value != null && value.version() > 0 && value.version() <= image.version()
                        && value.type() != null && !value.type().isBlank()
                        && value.content() != null && value.content().isObject());
                if (value.targets() != null) {
                    validateTargets(value.targets(), key, value.type(), definitions);
                }
            }
        }
        for (var entry : image.views().entrySet()) {
            var definition = definitions.get(entry.getKey().viewId());
            var view = entry.getValue();
            require(definition != null && !entry.getKey().entityId().isBlank());
            require(view.version() > 0 && view.version() <= image.version() && view.data() != null);
            require(definition.fields().keySet().containsAll(view.data().keySet()));
            require(view.provenance() != null && view.provenance().keySet().equals(view.data().keySet()));
            for (var field : view.data().entrySet()) {
                var binding = definition.fields().get(field.getKey());
                var provenance = view.provenance().get(field.getKey());
                require(provenance != null && binding.sourceId().equals(provenance.sourceId())
                        && epochs.get(binding.sourceId()).equals(provenance.epoch())
                        && provenance.sourceEntityId() != null);
                var resolver = definition.entities().get(binding.sourceId());
                var resolved = EntityStrategySelection.select(resolver.mode(), resolver.keys())
                        .resolve(provenance.sourceEntityId());
                require(entry.getKey().entityId().equals(resolved.entityId()));
                var streamKey = new Publication.StreamKey(provenance.sourceId(), provenance.epoch(),
                        provenance.sourceEntityId());
                require(image.streams().containsKey(streamKey));
                var value = field.getValue();
                require(value != null);
                if (binding.mode().equals("historyBySequence")) {
                    require(value.isArray() && !value.isEmpty()
                            && value.size() <= configuration.maxHistoryEntries());
                    long previous = 0;
                    for (var contribution : value) {
                        validateContribution(contribution);
                        long sequence = contribution.path("publicationSequence").longValue();
                        require(sequence > previous);
                        previous = sequence;
                    }
                } else {
                    validateContribution(value);
                }
            }
        }
    }

    private static void validateTargets(List<TargetOutcome> targets, Publication.StreamKey key,
            String type, Map<String, V2Configuration.View> definitions) {
        var seen = new HashSet<String>();
        for (var target : targets) {
            require(target != null && seen.add(target.viewId()));
            var definition = definitions.get(target.viewId());
            require(definition != null);
            var matching = definition.fields().entrySet().stream()
                    .filter(field -> field.getValue().sourceId().equals(key.sourceId())
                            && field.getValue().type().equals(type))
                    .map(Map.Entry::getKey).sorted().toList();
            require(!matching.isEmpty());
            var resolver = definition.entities().get(key.sourceId());
            var resolved = EntityStrategySelection.select(resolver.mode(), resolver.keys())
                    .resolve(key.sourceEntityId());
            if (resolved.resolved()) {
                require("accepted".equals(target.status()) && target.reason() == null
                        && resolved.entityId().equals(target.entityId()));
            } else {
                require("rejected".equals(target.status()) && "unknownEntityMapping".equals(target.reason())
                        && target.entityId() == null && target.changedFields().isEmpty());
            }
            require(matching.containsAll(target.changedFields())
                    && target.changedFields().equals(target.changedFields().stream().distinct().sorted().toList()));
        }
    }

    private static void validateContribution(tools.jackson.databind.JsonNode value) {
        var sequence = value.path("publicationSequence");
        require(value.isObject() && value.size() == 2 && value.path("payload").isObject()
                && sequence.isIntegralNumber() && sequence.canConvertToLong()
                && sequence.longValue() > 0 && sequence.longValue() <= PublicationJson.MAX_SEQUENCE);
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new IllegalStateException("Invalid recovered v2 state");
        }
    }
}
