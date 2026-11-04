package io.zooglass.v2;

import java.util.List;

/** Original processing outcome for one matched view, retained with the receipt. */
public record TargetOutcome(String viewId, String entityId, String status, String reason,
        List<String> changedFields) {
    public TargetOutcome {
        changedFields = List.copyOf(changedFields);
    }
}
