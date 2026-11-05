package io.zooglass.strategy.progress;

import java.util.List;

/**
 * Compact source-owned facts; missing classifications are derived from these ranges and the floor.
 */
public record ProgressState(
        long receivedThrough,
        long observedThrough,
        Long watermarkThrough,
        Long watermarkVersion,
        boolean sourceContractViolated,
        List<Range> received) {
    public ProgressState {
        received = List.copyOf(received);
    }

    public record Range(long from, long through) {}

    public record Missing(long from, long through, String status) {}
}
