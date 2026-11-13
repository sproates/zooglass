package io.zooglass.runtime;

import io.zooglass.simulation.RuntimeGeneration;
import io.zooglass.simulation.TurnContext;

/** Clock samples come only from the current owned turn. */
final class ControlledReceiptClock implements ReceiptClock {
    private final TurnContext turns;
    private final RuntimeGeneration generation;

    ControlledReceiptClock(TurnContext turns, RuntimeGeneration generation) {
        this.turns = turns;
        this.generation = generation;
    }

    @Override
    public long wallMillis() {
        return generation.wallMillis(turns.now());
    }

    @Override
    public long monotonicMillis() {
        return generation.monotonicMillis(turns.now());
    }
}
