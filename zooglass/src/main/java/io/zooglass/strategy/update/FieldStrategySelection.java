package io.zooglass.strategy.update;

import io.zooglass.ViewConfiguration;

/** Binds validated field configuration once, when its view is registered. */
public final class FieldStrategySelection {

    private FieldStrategySelection() {}

    public static FieldUpdateStrategy select(ViewConfiguration.Ordering ordering) {
        if (ordering == null) {
            return new ArrivalReplacement();
        }
        return switch (ordering.mode()) {
            case "latestBySequence" -> new LatestBySequence(ordering.sequenceField());
            case "historyBySequence" -> new HistoryBySequence(ordering.sequenceField());
            default ->
                    throw new IllegalArgumentException(
                            "Unsupported ordering mode: " + ordering.mode());
        };
    }
}
