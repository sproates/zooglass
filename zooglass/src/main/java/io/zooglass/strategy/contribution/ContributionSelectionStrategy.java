package io.zooglass.strategy.contribution;

import java.util.Map;

public interface ContributionSelectionStrategy {
    SelectedContribution select(Map<String, SelectedContribution> candidates);
}
