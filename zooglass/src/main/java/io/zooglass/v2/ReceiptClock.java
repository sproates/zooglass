package io.zooglass.v2;

import java.util.concurrent.TimeUnit;

/** Wall time is durable; elapsed time belongs only to this process. */
interface ReceiptClock {
    long wallMillis();

    long monotonicMillis();

    // Bracket the wall reading so a pause between calls cannot masquerade as a clock adjustment.
    default Sample sample() {
        long before = monotonicMillis();
        long wall = wallMillis();
        return new Sample(before, wall, monotonicMillis());
    }

    record Sample(long before, long wall, long after) {
        long minimumOffset() {
            return wall - after;
        }

        long maximumOffset() {
            return wall - before;
        }
    }

    ReceiptClock SYSTEM =
            new ReceiptClock() {
                private final long origin = System.nanoTime();

                public long wallMillis() {
                    return System.currentTimeMillis();
                }

                public long monotonicMillis() {
                    return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - origin);
                }
            };
}
