package io.zooglass.strategy.contribution;

import java.util.Map;

/** Exposes the only configured input. */
public final class IndependentFields implements ContributionSelectionStrategy {
    private final String source;

    IndependentFields(String source) {
        this.source = source;
    }

    public SelectedContribution select(Map<String, SelectedContribution> candidates) {
        return candidates.get(source);
    }
}
