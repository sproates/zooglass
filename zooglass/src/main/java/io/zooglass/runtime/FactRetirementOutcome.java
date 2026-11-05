package io.zooglass.runtime;

import java.util.List;
import java.util.Map;

public record FactRetirementOutcome(
        String kind,
        String status,
        String reason,
        FactRetirement control,
        Long version,
        Map<String, Long> floors,
        List<String> changedViews) {
    static FactRetirementOutcome rejected(FactRetirement control, Long version, String reason) {
        return new FactRetirementOutcome(
                "factRetirement", "rejected", reason, control, version, Map.of(), List.of());
    }
}
