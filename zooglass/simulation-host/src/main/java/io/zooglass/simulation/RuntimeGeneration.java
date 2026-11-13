package io.zooglass.simulation;

/** A JVM's fixed clock origin. Transport and alarms continue to use global time. */
public record RuntimeGeneration(long number, long startTimeMs, long epochMillis) {
    static final RuntimeGeneration FIXED_PROOF = new RuntimeGeneration(1, 0, 1_000_000);

    public long monotonicMillis(long globalTimeMs) {
        return Math.subtractExact(globalTimeMs, startTimeMs);
    }

    public long wallMillis(long globalTimeMs) {
        return Math.addExact(epochMillis, globalTimeMs);
    }
}
