package io.zooglass.runtime;

/** Owns deferred, one-shot wakeups. Scheduling never invokes the callback inline. */
interface AlarmScheduler extends AutoCloseable {
    Task schedule(Runnable wake, long delayMillis);

    interface Task {
        boolean isDone();

        /** Prevent dispatch if it has not begun; an already running callback may finish. */
        void cancel();
    }

    /** Cancel outstanding wakeups and release owned resources. */
    @Override
    void close();
}
