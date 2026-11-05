package io.zooglass.strategy.update;

/** Binds validated field configuration once, when its view is registered. */
public final class FieldStrategySelection {

    private FieldStrategySelection() {}

    public static FieldUpdateStrategy select(String mode, String sequenceField) {
        if ("arrival".equals(mode)) {
            return new ArrivalReplacement();
        }
        return switch (mode) {
            case "latestBySequence" -> new LatestBySequence(sequenceField);
            case "historyBySequence" -> new HistoryBySequence(sequenceField);
            default -> throw new IllegalArgumentException("Unsupported ordering mode: " + mode);
        };
    }
}
