package io.zooglass.runtime;

import io.zooglass.simulation.TurnContext;

/** Composition adapter; all reconciliation remains in the shared production runtime. */
public final class TimelineRuntime {
    private TimelineRuntime() {}

    public static RuntimeConfiguration inspectConfiguration(String json) {
        return RuntimeConfiguration.parseConfiguration(json);
    }

    public static ViewCoordinator create(RuntimeConfiguration config, TurnContext turns) {
        return create(config, turns, 1_000_000);
    }

    public static ViewCoordinator create(RuntimeConfiguration config, TurnContext turns, long epoch) {
        turns.check();
        if (!config.storage().equals("memory"))
            throw new IllegalArgumentException("POC supports memory only");
        return new ViewCoordinator(
                config,
                "",
                new ControlledReceiptClock(turns, epoch),
                null,
                () -> new ControlledAlarmScheduler(turns));
    }
}
