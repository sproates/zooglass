package io.zooglass.runtime;

import java.util.List;

/** Original processing outcome for one matched view, retained with the receipt. */
public record TargetOutcome(
        String viewId,
        String entityId,
        String status,
        String reason,
        List<String> changedFields,
        List<FieldOutcome> fields) {
    public TargetOutcome(
            String viewId,
            String entityId,
            String status,
            String reason,
            List<String> changedFields) {
        this(
                viewId,
                entityId,
                status,
                reason,
                changedFields,
                changedFields.stream()
                        .map(field -> new FieldOutcome(field, "accepted", null, true))
                        .toList());
    }

    public record FieldOutcome(String field, String status, String reason, boolean changed) {}

    public TargetOutcome {
        changedFields = List.copyOf(changedFields);
        fields = fields == null ? null : List.copyOf(fields);
    }
}
