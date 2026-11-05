package io.zooglass.v2;

import io.zooglass.strategy.contribution.ContributionStrategySelection;
import io.zooglass.strategy.freshness.ReceiptAge;
import io.zooglass.strategy.identity.EntityStrategySelection;
import io.zooglass.strategy.progress.ProgressState;

import java.util.Map;
import java.util.stream.Collectors;

/** Validates recovered candidates and the exposed views they produce. */
final class ViewRecovery {
    private ViewRecovery() {}

    static void validate(
            StateImage image,
            V2Configuration configuration,
            Map<String, String> epochs,
            Map<String, V2Configuration.View> definitions,
            Map<String, V2Configuration.Source> sourceDefinitions) {
        var pendingCounts = new java.util.HashMap<String, Long>();
        for (var entry : image.views().entrySet()) {
            var definition = definitions.get(entry.getKey().viewId());
            var view = entry.getValue();
            require(definition != null && !entry.getKey().entityId().isBlank());
            require(view.version() > 0 && view.version() <= image.version() && view.data() != null);
            require(definition.fields().keySet().containsAll(view.data().keySet()));
            require(
                    view.provenance() != null
                            && view.provenance().keySet().equals(view.data().keySet()));
            require(
                    view.candidates() != null
                            && definition
                                    .fields()
                                    .keySet()
                                    .containsAll(view.candidates().keySet()));
            var policy = definition.publication().bind(definition.fields().keySet());
            boolean expose = policy.missingRequired(view.candidates().keySet()).isEmpty();
            require(
                    expose
                            ? view.candidates().keySet().equals(view.data().keySet())
                            : view.data().isEmpty());
            if (view.pending()) {
                long count = pendingCounts.merge(definition.id(), 1L, Long::sum);
                require(!policy.atCapacity(count - 1));
            }
            for (var field : view.candidates().entrySet()) {
                var binding = definition.fields().get(field.getKey());
                var inputs =
                        binding.allInputs().stream()
                                .map(V2Configuration.Input::sourceId)
                                .collect(Collectors.toSet());
                require(
                        !field.getValue().isEmpty()
                                && inputs.containsAll(field.getValue().keySet()));
                for (var candidate : field.getValue().entrySet()) {
                    var retained = candidate.getValue();
                    require(retained != null);
                    validateAge(retained.age(), binding, image.lastWallMillis());
                    var provenance = retained.provenance();
                    require(
                            provenance != null
                                    && candidate.getKey().equals(provenance.sourceId())
                                    && epochs.get(candidate.getKey()).equals(provenance.epoch())
                                    && provenance.sourceEntityId() != null
                                    && !provenance.sourceEntityId().isBlank());
                    var resolver = definition.entities().get(candidate.getKey());
                    var resolved =
                            EntityStrategySelection.select(resolver.mode(), resolver.keys())
                                    .resolve(provenance.sourceEntityId());
                    require(entry.getKey().entityId().equals(resolved.entityId()));
                    var sourceStream =
                            image.streams()
                                    .get(
                                            new Publication.StreamKey(
                                                    provenance.sourceId(),
                                                    provenance.epoch(),
                                                    provenance.sourceEntityId()));
                    require(sourceStream != null);
                    validateValue(
                            retained.value(),
                            binding,
                            sourceStream,
                            sourceDefinitions.get(provenance.sourceId()).progress(),
                            configuration.maxHistoryEntries());
                }
                var conflict = binding.conflict();
                var selection =
                        ContributionStrategySelection.select(
                                conflict == null ? "independentFields" : conflict.mode(),
                                conflict == null ? null : conflict.sources(),
                                inputs);
                var selected = selection.select(field.getValue());
                if (expose) {
                    require(
                            selected.value().equals(view.data().get(field.getKey()))
                                    && selected.provenance()
                                            .equals(view.provenance().get(field.getKey())));
                }
            }
        }
    }

    private static void validateAge(
            ReceiptAge age, V2Configuration.Field binding, Long lastWallMillis) {
        if (age == null) {
            return;
        }
        require("receiptAge".equals(binding.freshness().mode()));
        if (age.receivedAtMillis() != null) {
            require(lastWallMillis != null && age.receivedAtMillis() <= lastWallMillis);
        }
    }

    private static void validateValue(
            tools.jackson.databind.JsonNode value,
            V2Configuration.Field binding,
            StateImage.StreamState sourceStream,
            V2Configuration.Progress progress,
            int maxHistoryEntries) {
        require(value != null);
        if (binding.facts() != null) {
            require(binding.mode().equals("sumActiveFacts") ? value.isNumber() : value.isArray());
        } else if (binding.mode().equals("historyBySequence")) {
            require(value.isArray() && !value.isEmpty() && value.size() <= maxHistoryEntries);
            long previous = 0;
            for (var contribution : value) {
                validateContribution(contribution);
                validateReceivedCandidate(sourceStream, progress, contribution);
                long sequence = contribution.path("publicationSequence").longValue();
                require(sequence > previous);
                previous = sequence;
            }
        } else {
            validateContribution(value);
            validateReceivedCandidate(sourceStream, progress, value);
        }
    }

    private static void validateReceivedCandidate(
            StateImage.StreamState stream,
            V2Configuration.Progress settings,
            tools.jackson.databind.JsonNode contribution) {
        if (stream.progress() == null) {
            return;
        }
        long sequence = contribution.path("publicationSequence").longValue();
        require(sequence >= settings.startSequence() && received(stream.progress(), sequence));
    }

    static boolean received(ProgressState progress, long sequence) {
        return (sequence <= progress.receivedThrough()
                || progress.received().stream()
                        .anyMatch(
                                range -> sequence >= range.from() && sequence <= range.through()));
    }

    private static void validateContribution(tools.jackson.databind.JsonNode value) {
        var sequence = value.path("publicationSequence");
        require(
                value.isObject()
                        && value.size() == 2
                        && value.path("payload").isObject()
                        && sequence.isIntegralNumber()
                        && sequence.canConvertToLong()
                        && sequence.longValue() > 0
                        && sequence.longValue() <= PublicationJson.MAX_SEQUENCE);
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new IllegalStateException("Invalid recovered v2 state");
        }
    }
}
