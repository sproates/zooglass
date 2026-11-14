package io.zooglass.simulation;

import io.zooglass.runtime.PublicationJson;

/** Generation-local clock, adjusted only by an admitted host turn. */
public final class RuntimeGeneration {
    static final RuntimeGeneration FIXED_PROOF = new RuntimeGeneration(1, 0, 1_000_000);

    private final long number;
    private final long startTimeMs;
    private final long epochMillis;
    private long wallOffsetMillis;

    public RuntimeGeneration(long number, long startTimeMs, long epochMillis) {
        this(number, startTimeMs, epochMillis, 0);
    }

    RuntimeGeneration(long number, long startTimeMs, long epochMillis, long wallOffsetMillis) {
        this.number = number;
        this.startTimeMs = startTimeMs;
        this.epochMillis = epochMillis;
        this.wallOffsetMillis = wallOffsetMillis;
    }

    public long number() {
        return number;
    }

    public long startTimeMs() {
        return startTimeMs;
    }

    public long epochMillis() {
        return epochMillis;
    }

    public long monotonicMillis(long globalTimeMs) {
        return Math.subtractExact(globalTimeMs, startTimeMs);
    }

    public long wallMillis(long globalTimeMs) {
        return boundedWallMillis(Math.addExact(baseWallMillis(globalTimeMs), wallOffsetMillis));
    }

    void setWallMillis(long globalTimeMs, long wallMillis) {
        wallOffsetMillis = Math.subtractExact(boundedWallMillis(wallMillis), baseWallMillis(globalTimeMs));
    }

    private long baseWallMillis(long globalTimeMs) {
        return boundedWallMillis(Math.addExact(epochMillis, globalTimeMs));
    }

    private static long boundedWallMillis(long value) {
        if (value < 0 || value > PublicationJson.MAX_SEQUENCE)
            throw new IllegalArgumentException("Wall clock outside safe integer range");
        return value;
    }
}
