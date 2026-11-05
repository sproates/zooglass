package io.zooglass.strategy.publication;

import java.util.List;
import java.util.Set;

public record RequireContributions(List<String> required, long maxPendingEntities)
        implements PublicationStrategy {
    public RequireContributions {
        required = List.copyOf(required);
    }

    public List<String> missingRequired(Set<String> present) {
        return required.stream().filter(field -> !present.contains(field)).toList();
    }

    public boolean atCapacity(long pendingEntities) {
        return pendingEntities >= maxPendingEntities;
    }
}
