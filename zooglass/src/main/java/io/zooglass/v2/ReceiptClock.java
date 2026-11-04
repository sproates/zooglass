package io.zooglass.v2;

import java.util.concurrent.TimeUnit;

/** Wall time is durable; elapsed time belongs only to this process. */
interface ReceiptClock {
    long wallMillis();
    long monotonicMillis();

    ReceiptClock SYSTEM = new ReceiptClock() {
        private final long origin = System.nanoTime();
        public long wallMillis() { return System.currentTimeMillis(); }
        public long monotonicMillis() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - origin); }
    };
}
