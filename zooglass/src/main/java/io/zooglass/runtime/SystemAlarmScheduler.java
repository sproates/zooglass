package io.zooglass.runtime;

import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Production driver; controlled runtimes supply their own deferred dispatcher. */
final class SystemAlarmScheduler implements AlarmScheduler {
    private final ScheduledThreadPoolExecutor timer =
            new ScheduledThreadPoolExecutor(
                    1, Thread.ofPlatform().daemon().name("zooglass-receipt-age").factory());

    SystemAlarmScheduler() {
        timer.setRemoveOnCancelPolicy(true);
    }

    public Task schedule(Runnable wake, long delayMillis) {
        var future = timer.schedule(wake, delayMillis, TimeUnit.MILLISECONDS);
        return new Task() {
            public boolean isDone() {
                return future.isDone();
            }

            public void cancel() {
                future.cancel(false);
            }
        };
    }

    public void close() {
        timer.shutdownNow();
    }
}
