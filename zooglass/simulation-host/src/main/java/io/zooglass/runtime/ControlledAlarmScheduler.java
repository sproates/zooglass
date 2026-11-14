package io.zooglass.runtime;

import io.zooglass.simulation.TurnContext;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Alarm callbacks belong to the turn agenda; no worker or host timer is created. */
final class ControlledAlarmScheduler implements AlarmScheduler {
    private final TurnContext turns;
    private final Set<Long> tasks = new LinkedHashSet<>();
    private boolean closed;

    ControlledAlarmScheduler(TurnContext turns) {
        this.turns = turns;
    }

    @Override
    public Task schedule(Runnable wake, long delay) {
        turns.check();
        if (closed) throw new IllegalStateException("Closed alarm driver");
        var alarm = new Alarm(wake);
        alarm.id = turns.schedule(Math.addExact(turns.now(), delay), 1, "alarm", alarm::run);
        tasks.add(alarm.id);
        return alarm;
    }

    @Override
    public void close() {
        turns.check();
        closed = true;
        for (long task : List.copyOf(tasks)) turns.cancel(task);
        tasks.clear();
    }

    private final class Alarm implements Task {
        private final Runnable wake;
        private long id;
        private boolean done;

        private Alarm(Runnable wake) {
            this.wake = wake;
        }

        @Override
        public boolean isDone() {
            turns.check();
            return done;
        }

        @Override
        public void cancel() {
            turns.check();
            done = true;
            tasks.remove(id);
            turns.cancel(id);
        }

        private void run() {
            done = true;
            tasks.remove(id);
            wake.run();
        }
    }
}
