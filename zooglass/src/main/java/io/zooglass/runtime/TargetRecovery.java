package io.zooglass.runtime;

import io.zooglass.strategy.identity.EntityStrategySelection;

import java.util.HashSet;
import java.util.List;
import java.util.Map;

/** Validates the per-target outcomes retained in publication receipts. */
final class TargetRecovery {
    private TargetRecovery() {}

    static void validate(
            List<TargetOutcome> targets,
            Publication.StreamKey key,
            String type,
            Map<String, RuntimeConfiguration.View> definitions) {
        var seen = new HashSet<String>();
        for (var target : targets) {
            require(target != null && seen.add(target.viewId()));
            var definition = definitions.get(target.viewId());
            require(definition != null);
            var matching =
                    definition.fields().entrySet().stream()
                            .filter(field -> matches(field.getValue(), key.sourceId(), type))
                            .map(Map.Entry::getKey)
                            .sorted()
                            .toList();
            require(!matching.isEmpty());
            var resolver = definition.entities().get(key.sourceId());
            var resolved =
                    EntityStrategySelection.select(resolver.mode(), resolver.keys())
                            .resolve(key.sourceEntityId());
            if (resolved.resolved()) {
                require(resolved.entityId().equals(target.entityId()));
                validateResolved(target, definition, matching);
            } else {
                require(
                        "rejected".equals(target.status())
                                && "unknownEntityMapping".equals(target.reason())
                                && target.entityId() == null
                                && target.changedFields().isEmpty()
                                && (target.fields() == null || target.fields().isEmpty()));
            }
            require(
                    definition.fields().keySet().containsAll(target.changedFields())
                            && target.changedFields()
                                    .equals(
                                            target.changedFields().stream()
                                                    .distinct()
                                                    .sorted()
                                                    .toList()));
        }
    }

    private static boolean matches(RuntimeConfiguration.Field field, String sourceId, String type) {
        return field.allInputs().stream()
                .anyMatch(input -> input.sourceId().equals(sourceId) && input.type().equals(type));
    }

    private static void validateResolved(
            TargetOutcome target, RuntimeConfiguration.View definition, List<String> matching) {
        if (target.fields() == null) {
            require(
                    "accepted".equals(target.status())
                            && target.reason() == null
                            && matching.containsAll(target.changedFields()));
        } else {
            require(
                    target.fields().stream()
                            .map(TargetOutcome.FieldOutcome::field)
                            .toList()
                            .equals(matching));
            for (var outcome : target.fields()) {
                require(outcome != null);
                if ("accepted".equals(outcome.status())) {
                    require(outcome.reason() == null);
                } else {
                    var field = definition.fields().get(outcome.field());
                    boolean rejectedLate =
                            "behindWatermark".equals(outcome.reason())
                                    && "rejectBehindWatermark".equals(field.late().mode());
                    require(
                            "rejected".equals(outcome.status())
                                    && (rejectedLate
                                            || FactRecovery.policyRejection(
                                                    outcome.reason(), field)));
                }
            }
            boolean accepted =
                    target.fields().stream().anyMatch(field -> "accepted".equals(field.status()));
            require(
                    accepted
                            ? "accepted".equals(target.status()) && target.reason() == null
                            : "rejected".equals(target.status())
                                    && java.util.Objects.equals(
                                            target.fields().getFirst().reason(), target.reason()));
            validateChangedFields(target, definition, matching, accepted);
        }
    }

    private static void validateChangedFields(
            TargetOutcome target,
            RuntimeConfiguration.View definition,
            List<String> matching,
            boolean accepted) {
        var changed = target.changedFields();
        require(
                changed.stream()
                        .filter(matching::contains)
                        .toList()
                        .equals(
                                target.fields().stream()
                                        .filter(TargetOutcome.FieldOutcome::changed)
                                        .map(TargetOutcome.FieldOutcome::field)
                                        .toList()));
        boolean release =
                !matching.containsAll(changed)
                        || target.fields().stream()
                                .anyMatch(
                                        field ->
                                                "rejected".equals(field.status())
                                                        && field.changed());
        if (release) {
            var policy = definition.publication();
            require(
                    "requireContributions".equals(policy.mode())
                            && accepted
                            && changed.containsAll(policy.fields())
                            && target.fields().stream()
                                    .anyMatch(
                                            f ->
                                                    policy.fields().contains(f.field())
                                                            && "accepted".equals(f.status())
                                                            && f.changed()));
        }
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new IllegalStateException("Invalid recovered state");
        }
    }
}
