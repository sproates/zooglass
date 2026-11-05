package io.zooglass.strategy.publication;

import java.util.List;
import java.util.Set;

public final class PublicationStrategySelection {

    private PublicationStrategySelection() {}

    public static PublicationStrategy select(
            String mode, List<String> required, Long capacity, Set<String> fields) {
        if ("publishPartial".equals(mode) && required == null && capacity == null) {
            return new PublishPartial();
        }
        if ("requireContributions".equals(mode)
                && required != null
                && !required.isEmpty()
                && fields.containsAll(required)
                && required.stream().distinct().count() == required.size()
                && capacity != null
                && capacity > 0
                && capacity <= 9007199254740991L) {
            return new RequireContributions(required, capacity);
        }
        throw new IllegalArgumentException("Invalid view publication policy");
    }
}
