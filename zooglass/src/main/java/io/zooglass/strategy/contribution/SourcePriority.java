package io.zooglass.strategy.contribution;

import java.util.List;
import java.util.Map;

/** Selects the first present source without comparing source sequence domains. */
public final class SourcePriority implements ContributionSelectionStrategy {

    private final List<String> sources;

    SourcePriority(List<String> sources) {
        this.sources = List.copyOf(sources);
    }

    public SelectedContribution select(Map<String, SelectedContribution> candidates) {
        for (String source : sources) {
            if (candidates.containsKey(source)) {
                return candidates.get(source);
            }
        }
        return null;
    }
}
