package io.zooglass.logging;

import java.util.LinkedHashMap;
import java.util.Map;

/** One lazy worker, one pending entry per event. Never retain sessions, frames, failures or request text. */
final class DeferredViewerEvents {
    interface Sink {
        void emit(ViewerLog.Event event, ViewerLog.ConnectionRef reference, long occurrences);
    }

    private static final class Pending {
        final ViewerLog.ConnectionRef reference;
        long count = 1;

        Pending(ViewerLog.ConnectionRef reference) {
            this.reference = reference;
        }
    }

    private final LinkedHashMap<ViewerLog.Event, Pending> waiting = new LinkedHashMap<>();
    private final Sink sink;
    private boolean started;
    private boolean closed;

    DeferredViewerEvents(Sink sink) {
        this.sink = sink;
    }

    synchronized void offer(ViewerLog.Event event, ViewerLog.ConnectionRef reference) {
        if (closed) return;
        if (!started) {
            try {
                Thread.ofVirtual().name("zooglass-viewer-log").start(this::run);
                started = true;
            } catch (RuntimeException unavailable) {
                closed = true;
                return;
            }
        }
        var previous = waiting.get(event);
        if (previous == null) {
            waiting.put(event, new Pending(reference));
            notifyAll();
        } else if (previous.count != Long.MAX_VALUE) {
            previous.count++;
        }
    }

    private void run() {
        try {
            while (true) {
                Map.Entry<ViewerLog.Event, Pending> next;
                synchronized (this) {
                    while (!closed && waiting.isEmpty()) wait();
                    if (closed) return;
                    next = waiting.pollFirstEntry();
                }
                var entry = next.getValue();
                sink.emit(next.getKey(), entry.reference, entry.count);
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } finally {
            close();
        }
    }

    /** Shutdown discards waiting signals. A blocked daemon worker exits when its sink returns. */
    synchronized void close() {
        closed = true;
        waiting.clear();
        notifyAll();
    }
}
