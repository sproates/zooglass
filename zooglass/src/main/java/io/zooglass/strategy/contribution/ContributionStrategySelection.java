package io.zooglass.strategy.contribution;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Validates settings and binds the concrete contribution policy. */
public final class ContributionStrategySelection {
    private ContributionStrategySelection() {}

    public static ContributionSelectionStrategy select(String mode, List<String> sources, Set<String> inputs) {
        if ("independentFields".equals(mode) && sources == null && inputs.size() == 1) {
            return new IndependentFields(inputs.iterator().next());
        }
        if ("sourcePriority".equals(mode) && sources != null && sources.size() == inputs.size()
                && new HashSet<>(sources).equals(inputs)) {
            return new SourcePriority(sources);
        }
        throw new IllegalArgumentException("Invalid contribution strategy or source priority");
    }
}
