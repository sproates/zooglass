package io.zooglass.strategy.publication;

import java.util.List;
import java.util.Set;

/** Decides exposure from field presence, independently of source ordering. */
public interface PublicationStrategy {
    List<String> missingRequired(Set<String> present);

    default boolean atCapacity(long pendingEntities) {
        return false;
    }
}
