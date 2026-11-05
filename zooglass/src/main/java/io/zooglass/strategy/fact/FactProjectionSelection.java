package io.zooglass.strategy.fact;

/** Only the delivered collection projection is selectable in this slice. */
public final class FactProjectionSelection {
    private FactProjectionSelection() {}

    public static ActiveFacts select(String mode) {
        if ("activeFacts".equals(mode)) return new ActiveFacts();
        throw new IllegalArgumentException("Unsupported fact projection");
    }
}
