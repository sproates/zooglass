package io.zooglass.runtime;

import io.zooglass.simulation.TurnContext;

import java.util.LinkedHashSet;
import java.util.Set;

/** Internal POC composition: clock samples and alarms belong to explicit host turns. */
public final class TimelineRuntime {
    private TimelineRuntime() {}

    public static ViewCoordinator create(RuntimeConfiguration config, TurnContext turns) {
        turns.check();
        if (!config.storage().equals("memory"))
            throw new IllegalArgumentException("POC supports memory only");
        var clock =
                new ReceiptClock() {
                    public long wallMillis() {
                        return 1_000_000 + turns.now();
                    }

                    public long monotonicMillis() {
                        return turns.now();
                    }
                };
        return new ViewCoordinator(
                config,
                "",
                clock,
                null,
                () ->
                        new AlarmScheduler() {
                            final Set<Long> tasks = new LinkedHashSet<>();
                            boolean closed;

                            public Task schedule(Runnable wake, long delay) {
                                turns.check();
                                if (closed) throw new IllegalStateException("Closed alarm driver");
                                class Alarm implements Task {
                                    long id;
                                    boolean done;

                                    public boolean isDone() {
                                        turns.check();
                                        return done;
                                    }

                                    public void cancel() {
                                        turns.check();
                                        done = true;
                                        tasks.remove(id);
                                        turns.cancel(id);
                                    }

                                    void run() {
                                        done = true;
                                        tasks.remove(id);
                                        wake.run();
                                    }
                                }
                                var alarm = new Alarm();
                                alarm.id =
                                        turns.schedule(
                                                Math.addExact(turns.now(), delay),
                                                1,
                                                "alarm",
                                                alarm::run);
                                tasks.add(alarm.id);
                                return alarm;
                            }

                            public void close() {
                                turns.check();
                                closed = true;
                                for (long task : java.util.List.copyOf(tasks)) turns.cancel(task);
                                tasks.clear();
                            }
                        });
    }
}
