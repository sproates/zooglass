package io.zooglass.strategy.fact;

public final class FactRevisionSelection {
    private FactRevisionSelection() {}

    public static FactRevisionStrategy select(String mode) {
        if ("firstFact".equals(mode)) return new FirstFact();
        if ("latestFactRevision".equals(mode)) return new LatestFactRevision();
        throw new IllegalArgumentException("Unknown fact revision policy");
    }
}
