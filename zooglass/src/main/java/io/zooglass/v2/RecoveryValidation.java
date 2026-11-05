package io.zooglass.v2;

import io.zooglass.strategy.progress.ProgressState;
import io.zooglass.strategy.progress.ProgressStrategySelection;

import io.zooglass.strategy.contribution.ContributionStrategySelection;

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
        var sourceDefinitions = configuration.sources().stream()
                .collect(Collectors.toMap(V2Configuration.Source::id, Function.identity()));
        var definitions = configuration.views().stream()
                .collect(Collectors.toMap(V2Configuration.View::id, Function.identity()));

        require(image.version() >= 0 && image.streams().size() <= configuration.maxStreams());
        for (var entry : image.streams().entrySet()) {
            var key = entry.getKey();
            var stream = entry.getValue();
            require(key.epoch().equals(epochs.get(key.sourceId())) && !key.sourceEntityId().isBlank());
            require(stream.floor() >= 1 && stream.floor() <= PublicationJson.MAX_SEQUENCE);
            var settings = sourceDefinitions.get(key.sourceId()).progress();
            var policy = ProgressStrategySelection.select(settings.mode(),
                    settings.startSequence(), settings.maxReceivedRanges(), settings.maxMissingRanges());
            policy.validate(stream.progress(), stream.floor(), image.version());
            require(stream.receipts() != null && (!stream.receipts().isEmpty()
                    || stream.progress() != null && stream.progress().watermarkThrough() != null || FactRecovery.owns(image, key))
                    && stream.receipts().size() <= configuration.identityWindow());
            for (var receipt : stream.receipts().entrySet()) {
                require(receipt.getKey() <= PublicationJson.MAX_SEQUENCE && receipt.getKey() >= stream.floor()
                        && receipt.getKey() - stream.floor() < configuration.identityWindow());
                if (stream.progress() != null) {
                    require(receipt.getKey() >= settings.startSequence() && received(stream.progress(), receipt.getKey()));
                }
                var value = receipt.getValue();
                require(value != null && value.version() > 0 && value.version() <= image.version()
                        && value.type() != null && !value.type().isBlank()
                        && value.content() != null && value.content().isObject());
                if (value.fact() != null) value.fact().validate(receipt.getKey(), value.content());
                if (value.targets() != null) {
                    validateTargets(value.targets(), key, value.type(), definitions);
                    boolean rejectedLate = value.targets().stream().filter(target -> target.fields() != null)
                            .flatMap(target -> target.fields().stream())
                            .anyMatch(field -> "behindWatermark".equals(field.reason()));
                    if (rejectedLate) require(stream.progress() != null && stream.progress().sourceContractViolated()
                            && stream.progress().watermarkThrough() != null
                            && receipt.getKey() <= stream.progress().watermarkThrough());
                }
            }
        }
        var pendingCounts = new java.util.HashMap<String, Long>();
        for (var entry : image.views().entrySet()) {
            var definition = definitions.get(entry.getKey().viewId());
            var view = entry.getValue();
            require(definition != null && !entry.getKey().entityId().isBlank());
            require(view.version() > 0 && view.version() <= image.version() && view.data() != null);
            require(definition.fields().keySet().containsAll(view.data().keySet()));
            require(view.provenance() != null && view.provenance().keySet().equals(view.data().keySet()));
            require(view.candidates() != null && definition.fields().keySet().containsAll(view.candidates().keySet()));
            var policy = definition.publication().bind(definition.fields().keySet());
            boolean expose = policy.missingRequired(view.candidates().keySet()).isEmpty();
            require(expose ? view.candidates().keySet().equals(view.data().keySet()) : view.data().isEmpty());
            if (view.pending()) {
                long count = pendingCounts.merge(definition.id(), 1L, Long::sum);
                require(!policy.atCapacity(count - 1));
            }
            for (var field : view.candidates().entrySet()) {
                var binding = definition.fields().get(field.getKey());
                var inputs = binding.allInputs().stream().map(V2Configuration.Input::sourceId)
                        .collect(Collectors.toSet());
                require(!field.getValue().isEmpty() && inputs.containsAll(field.getValue().keySet()));
                for (var candidate : field.getValue().entrySet()) {
                    var retained = candidate.getValue();
                    require(retained != null);
                    var age = retained.age();
                    if (age != null) {
                        require("receiptAge".equals(binding.freshness().mode()));
                        if (age.receivedAtMillis() != null) {
                            require(image.lastWallMillis() != null && age.receivedAtMillis() <= image.lastWallMillis());
                        }
                    }
                    var provenance = retained.provenance();
                    require(provenance != null && candidate.getKey().equals(provenance.sourceId())
                            && epochs.get(candidate.getKey()).equals(provenance.epoch())
                            && provenance.sourceEntityId() != null && !provenance.sourceEntityId().isBlank());
                    var resolver = definition.entities().get(candidate.getKey());
                    var resolved = EntityStrategySelection.select(resolver.mode(), resolver.keys())
                            .resolve(provenance.sourceEntityId());
                    require(entry.getKey().entityId().equals(resolved.entityId()));
                    var sourceStream = image.streams().get(new Publication.StreamKey(provenance.sourceId(),
                            provenance.epoch(), provenance.sourceEntityId()));
                    require(sourceStream != null);
                    var value = retained.value();
                    require(value != null);
                    if (binding.facts() != null) {
                        require(value.isArray()); // Full record/projection checks are in FactRecovery.
                    } else if (binding.mode().equals("historyBySequence")) {
                        require(value.isArray() && !value.isEmpty()
                                && value.size() <= configuration.maxHistoryEntries());
                        long previous = 0;
                        for (var contribution : value) {
                            validateContribution(contribution);
                            validateReceivedCandidate(sourceStream, sourceDefinitions.get(provenance.sourceId()).progress(), contribution);
                            long sequence = contribution.path("publicationSequence").longValue();
                            require(sequence > previous);
                            previous = sequence;
                        }
                    } else {
                        validateContribution(value);
                        validateReceivedCandidate(sourceStream, sourceDefinitions.get(provenance.sourceId()).progress(), value);
                    }
                }
                var conflict = binding.conflict();
                var selection = ContributionStrategySelection.select(
                        conflict == null ? "independentFields" : conflict.mode(),
                        conflict == null ? null : conflict.sources(), inputs);
                var selected = selection.select(field.getValue());
                if (expose) require(selected.value().equals(view.data().get(field.getKey()))
                        && selected.provenance().equals(view.provenance().get(field.getKey())));
            }
        }
        FactRecovery.validate(image, configuration);
    }

    private static void validateTargets(List<TargetOutcome> targets, Publication.StreamKey key,
            String type, Map<String, V2Configuration.View> definitions) {
        var seen = new HashSet<String>();
        for (var target : targets) {
            require(target != null && seen.add(target.viewId()));
            var definition = definitions.get(target.viewId());
            require(definition != null);
            var matching = definition.fields().entrySet().stream()
                    .filter(field -> field.getValue().allInputs().stream().anyMatch(input ->
                            input.sourceId().equals(key.sourceId()) && input.type().equals(type)))
                    .map(Map.Entry::getKey).sorted().toList();
            require(!matching.isEmpty());
            var resolver = definition.entities().get(key.sourceId());
            var resolved = EntityStrategySelection.select(resolver.mode(), resolver.keys())
                    .resolve(key.sourceEntityId());
            if (resolved.resolved()) {
                require(resolved.entityId().equals(target.entityId()));
                if (target.fields() == null) {
                    require("accepted".equals(target.status()) && target.reason() == null && matching.containsAll(target.changedFields()));
                } else {
                    require(target.fields().stream().map(TargetOutcome.FieldOutcome::field).toList().equals(matching));
                    for (var outcome : target.fields()) {
                        require(outcome != null);
                        if ("accepted".equals(outcome.status())) require(outcome.reason() == null);
                        else require("rejected".equals(outcome.status()) && (
                                "behindWatermark".equals(outcome.reason()) && "rejectBehindWatermark".equals(
                                        definition.fields().get(outcome.field()).late().mode())
                                || FactRecovery.policyRejection(outcome.reason(), definition.fields().get(outcome.field()))));
                    }
                    boolean accepted = target.fields().stream().anyMatch(field -> "accepted".equals(field.status()));
                    require(accepted ? "accepted".equals(target.status()) && target.reason() == null
                            : "rejected".equals(target.status()) && java.util.Objects.equals(target.fields().getFirst().reason(), target.reason()));
                    validateChangedFields(target, definition, matching, accepted);
                }
            } else {
                require("rejected".equals(target.status()) && "unknownEntityMapping".equals(target.reason())
                        && target.entityId() == null && target.changedFields().isEmpty()
                        && (target.fields() == null || target.fields().isEmpty()));
            }
            require(definition.fields().keySet().containsAll(target.changedFields())
                    && target.changedFields().equals(target.changedFields().stream().distinct().sorted().toList()));
        }
    }

    private static void validateChangedFields(TargetOutcome target, V2Configuration.View definition,
            List<String> matching, boolean accepted) {
        var changed = target.changedFields();
        require(changed.stream().filter(matching::contains).toList().equals(target.fields().stream()
                .filter(TargetOutcome.FieldOutcome::changed).map(TargetOutcome.FieldOutcome::field).toList()));
        boolean release = !matching.containsAll(changed) || target.fields().stream()
                .anyMatch(field -> "rejected".equals(field.status()) && field.changed());
        if (release) {
            var policy = definition.publication();
            require("requireContributions".equals(policy.mode()) && accepted
                    && changed.containsAll(policy.fields()) && target.fields().stream().anyMatch(
                            f -> policy.fields().contains(f.field()) && "accepted".equals(f.status()) && f.changed()));
        }
    }

    private static void validateReceivedCandidate(StateImage.StreamState stream, V2Configuration.Progress settings,
            tools.jackson.databind.JsonNode contribution) {
        if (stream.progress() == null) return;
        long sequence = contribution.path("publicationSequence").longValue();
        require(sequence >= settings.startSequence() && received(stream.progress(), sequence));
    }

    private static boolean received(ProgressState progress, long sequence) {
        return sequence <= progress.receivedThrough() || progress.received().stream()
                .anyMatch(range -> sequence >= range.from() && sequence <= range.through());
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
