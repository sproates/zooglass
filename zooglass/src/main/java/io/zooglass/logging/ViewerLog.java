package io.zooglass.logging;

import io.zooglass.access.AccessDecision;
import org.slf4j.Logger;
import org.slf4j.event.Level;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/** Viewer diagnostics accept closed categories and locally generated numeric references only. */
public final class ViewerLog {
    public static final ViewerLog NONE = new ViewerLog(null, null, null);

    public enum Event {
        OPEN("connection.opened", Level.DEBUG, null, "Viewer connection established."),
        NORMAL_CLOSE("connection.closed", Level.DEBUG, "normal", "Viewer connection closed."),
        OTHER_CLOSE("connection.closed", Level.DEBUG, "other", "Viewer connection closed."),
        INVALID("request.invalid", Level.DEBUG, "invalidViewRequest", "Viewer request rejected."),
        OPENING("delivery.failed", Level.WARN, "openingFailed", "Could not prepare subscription opening.", "opening", "unexpected"),
        UPDATE("delivery.failed", Level.WARN, "updateFailed", "Could not prepare a live view update.", "update", "unexpected"),
        ENQUEUE("delivery.failed", Level.WARN, "enqueueFailed", "Could not queue a live view message.", "enqueue", "unexpected"),
        LISTENER("delivery.failed", Level.WARN, "listenerFailed", "A snapshot listener failed.", "listener", "unexpected"),
        REQUEST("delivery.failed", Level.WARN, "requestFailed", "Could not process a viewer request.", "request", "unexpected"),
        CLOSE("delivery.failed", Level.WARN, "closeFailed", "Could not complete a transport close.", "close", "transport"),
        FULL("delivery.close_requested", Level.WARN, "queueFull", "Queue admission returned FULL; requested closure."),
        TOO_LARGE("delivery.close_requested", Level.WARN, "tooLarge", "Protected batch or frame exceeded queue capacity; requested closure."),
        WRITE("delivery.close_requested", Level.WARN, "writerFailed", "The outbound writer failed and requested closure.");

        private final Signal signal;

        Event(String name, Level level, String reason, String message) {
            this(name, level, reason, message, null, null);
        }

        Event(String name, Level level, String reason, String message, String stage, String category) {
            this.signal = new Signal(name, level, reason, message, stage, category);
        }
    }

    private record Signal(String name, Level level, String reason, String message, String stage, String category) {}

    private static final Signal UNAVAILABLE = new Signal("access.unavailable", Level.WARN, "unavailable",
            "No usable access decision was available.", null, null);
    private static final Signal UNAUTHENTICATED = new Signal("access.refused", Level.DEBUG, "unauthenticated",
            "Viewer admission was refused.", null, null);
    private static final Signal DENIED = new Signal("access.refused", Level.DEBUG, "denied",
            "Viewer admission was refused.", null, null);

    public enum Boundary {
        SNAPSHOT("snapshot", "http"), HANDSHAKE("handshake", "websocket"),
        SUBSCRIPTION("subscription", "websocket"), RENEWAL("renewal", "websocket"),
        HTTP_CREDENTIAL("credential", "http"), SOCKET_CREDENTIAL("credential", "websocket");

        private final String operation;
        private final String transport;

        Boundary(String operation, String transport) {
            this.operation = operation;
            this.transport = transport;
        }
    }

    public static final class ConnectionRef {
        private final long value;

        private ConnectionRef(long value) {
            this.value = value;
        }
    }

    private static final AtomicLong CONNECTIONS = new AtomicLong();
    private final Logger logger;
    private final String instance;
    private final LongSupplier nanos;
    private final Map<Signal, OperationalLog.Bucket> buckets = new HashMap<>();
    private final DeferredViewerEvents deferred;

    ViewerLog(Logger logger, String instance, LongSupplier nanos) {
        this.logger = logger;
        this.instance = instance;
        this.nanos = nanos;
        this.deferred = logger == null ? null : new DeferredViewerEvents(this::emitDeferred);
    }

    public ConnectionRef newConnection() {
        return logger == null ? null : new ConnectionRef(CONNECTIONS.incrementAndGet());
    }

    public void access(Boundary boundary, AccessDecision.Reason reason) {
        var event = switch (reason) {
            case UNAVAILABLE -> UNAVAILABLE;
            case UNAUTHENTICATED -> UNAUTHENTICATED;
            case DENIED -> DENIED;
        };
        emit(event, boundary, null, 1);
    }

    public void socket(Event event, ConnectionRef reference) {
        emit(event.signal, null, reference, 1);
    }

    /** May run under the coordinator: only bounded bookkeeping occurs on the calling thread. */
    public void deferred(Event event, ConnectionRef reference) {
        if (deferred != null) deferred.offer(event, reference);
    }

    public void close() {
        if (deferred != null) deferred.close();
    }

    private void emitDeferred(Event event, ConnectionRef reference, long occurrences) {
        emit(event.signal, null, reference, occurrences);
    }

    private void emit(Signal event, Boundary boundary, ConnectionRef reference, long occurrences) {
        if (logger == null) return;
        try {
            if (!logger.isEnabledForLevel(event.level)) return;
            long suppressed = admit(event, occurrences);
            if (suppressed < 0) return;
            var record = logger.atLevel(event.level)
                    .addKeyValue("event", event.name)
                    .addKeyValue("instanceId", instance);
            if (event.reason != null) record.addKeyValue("reason", event.reason);
            if (event.stage != null) {
                record.addKeyValue("stage", event.stage).addKeyValue("failureCategory", event.category);
            }
            if (boundary != null) {
                record.addKeyValue("transport", boundary.transport);
                if (event == UNAVAILABLE) record.addKeyValue("operation", boundary.operation);
            } else if (event != Event.LISTENER.signal) {
                record.addKeyValue("transport", "websocket");
            }
            if (event == Event.INVALID.signal) record.addKeyValue("operation", "viewRequest");
            if (reference != null) record.addKeyValue("connectionRef", reference.value);
            if (suppressed != 0) record.addKeyValue("suppressed", suppressed);
            record.log(event.message);
        } catch (RuntimeException ignored) {
            // Diagnostics must never replace policy or delivery outcomes.
        }
    }

    private synchronized long admit(Signal event, long occurrences) {
        long now = nanos.getAsLong();
        var bucket = buckets.get(event);
        if (bucket == null) {
            buckets.put(event, new OperationalLog.Bucket(now, occurrences - 1));
            return 0;
        }
        return bucket.admit(now, occurrences);
    }
}
