package io.zooglass.strategy.publication;

import java.util.List;
import java.util.Set;

public final class PublishPartial implements PublicationStrategy {

    public List<String> missingRequired(Set<String> present) {
        return List.of();
    }
}
