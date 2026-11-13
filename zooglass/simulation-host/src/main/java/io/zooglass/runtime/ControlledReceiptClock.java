package io.zooglass.runtime;

import io.zooglass.simulation.TurnContext;

/** Clock samples come only from the current owned turn. */
final class ControlledReceiptClock implements ReceiptClock {
    private final TurnContext turns;
    private final long epoch;

    ControlledReceiptClock(TurnContext turns, long epoch) {
        this.turns = turns;
        this.epoch = epoch;
    }

    @Override
    public long wallMillis() {
        return Math.addExact(epoch, turns.now());
    }

    @Override
    public long monotonicMillis() {
        return turns.now();
    }
}
