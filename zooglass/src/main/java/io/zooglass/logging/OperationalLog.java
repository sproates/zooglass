package io.zooglass.logging;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.event.Level;

import java.util.EnumMap;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/** ZooGlass-owned service records. Callers supply enums and counts, never request text. */
public final class OperationalLog {
    public static final OperationalLog NONE = new OperationalLog(null, null, null);

    public enum SourceOperation {
        PUBLICATION("publication", Signal.BAD_PUBLICATION),
        PROGRESS("progress", Signal.BAD_PROGRESS),
        RETIREMENT("factRetirement", Signal.BAD_RETIREMENT);

        private final String value;
        private final Signal invalid;

        SourceOperation(String value, Signal invalid) {
            this.value = value;
            this.invalid = invalid;
        }
    }

    public enum StoreOperation {
        INSTALL("install"), REGISTER("registerView");

        private final String value;

        StoreOperation(String value) {
            this.value = value;
        }
    }

    private enum Signal {
        READY("service.ready", Level.INFO, null, "Service is ready."),
        STOPPING("service.stopping", Level.INFO, null, "Service shutdown has begun."),
        START_CONFIG("service.start_failed", Level.ERROR, "configuration", "Service startup failed."),
        START_STORAGE("service.start_failed", Level.ERROR, "storage", "Service startup failed."),
        START_UNEXPECTED("service.start_failed", Level.ERROR, "unexpected", "Service startup failed."),
        STORAGE_LOST("storage.unavailable", Level.ERROR, "storage", "Storage requires restart recovery."),
        CLOSE_FAILED("storage.close_failed", Level.ERROR, "storage", "Storage close failed."),
        BAD_DEFINITION("configuration.rejected", Level.WARN, "malformed", "View registration was rejected."),
        INVALID_DEFINITION("configuration.rejected", Level.WARN, "invalid", "View registration was rejected."),
        BAD_PUBLICATION("request.invalid", Level.DEBUG, "invalidEnvelope", "Rejected an invalid publication."),
        BAD_PROGRESS("request.invalid", Level.DEBUG, "invalidProgress", "Rejected invalid progress control."),
        BAD_RETIREMENT("request.invalid", Level.DEBUG, "invalidFactRetirement", "Rejected invalid retirement control."),
        PROCESSING_FAILED("processing.failed", Level.ERROR, "unexpected", "Source processing failed."),
        RECEIPT_SERIALIZATION("receipt.send_failed", Level.WARN, "serialization", "Could not prepare a receipt."),
        RECEIPT_TRANSPORT("receipt.send_failed", Level.WARN, "transport", "Could not send a receipt.");

        final String event;
        final Level level;
        final String reason;
        final String message;

        Signal(String event, Level level, String reason, String message) {
            this.event = event;
            this.level = level;
            this.reason = reason;
            this.message = message;
        }
    }

    private static final class ProcessIdentity {
        static final String ID = UUID.randomUUID().toString();
    }

    private final Logger logger;
    private final String instance;
    private final LongSupplier nanos;
    private final Executor deferStorage;
    private final EnumMap<Signal, Bucket> buckets = new EnumMap<>(Signal.class);
    private volatile boolean reachedReady;
    private volatile Signal startupFailure = Signal.START_UNEXPECTED;

    public static OperationalLog forService() {
        return new OperationalLog(LoggerFactory.getLogger("io.zooglass.operations"), ProcessIdentity.ID, System::nanoTime);
    }

    OperationalLog(Logger logger, String instance, LongSupplier nanos) {
        this(logger, instance, nanos, Thread::startVirtualThread);
    }

    OperationalLog(Logger logger, String instance, LongSupplier nanos, Executor deferStorage) {
        this.logger = logger;
        this.instance = instance;
        this.nanos = nanos;
        this.deferStorage = deferStorage;
    }

    public void startupConfigurationFailed() {
        if (logger != null) startupFailure = Signal.START_CONFIG;
    }

    public void startupStorageFailed() {
        if (logger != null) startupFailure = Signal.START_STORAGE;
    }

    public void startFailed() {
        if (!reachedReady) emit(startupFailure, null, null, false);
    }

    void stopping() {
        emit(Signal.STOPPING, null, null, false);
    }

    public record Modes(boolean durable, boolean protectedAccess, int sourceCount, int viewCount) {}

    void ready(Modes modes) {
        reachedReady = true;
        emit(Signal.READY, null, modes, false);
    }

    public void registrationMalformed() {
        emit(Signal.BAD_DEFINITION, StoreOperation.REGISTER.value, null, true);
    }

    public void registrationInvalid() {
        emit(Signal.INVALID_DEFINITION, StoreOperation.REGISTER.value, null, true);
    }

    public void invalidInput(SourceOperation source) {
        emit(source.invalid, source.value, null, true);
    }

    public void processingFailed(SourceOperation source) {
        emit(Signal.PROCESSING_FAILED, source.value, null, true);
    }

    public void receiptSerializationFailed(SourceOperation source) {
        emit(Signal.RECEIPT_SERIALIZATION, source.value, null, true);
    }

    public void receiptTransportFailed(SourceOperation source) {
        emit(Signal.RECEIPT_TRANSPORT, source.value, null, true);
    }

    /** A store can lose availability only once. No appender or its filters run under the coordinator lock. */
    public void storageLost(StoreOperation operation) {
        if (logger == null) return;
        try {
            deferStorage.execute(() -> emit(Signal.STORAGE_LOST, operation.value, null, false));
        } catch (RuntimeException ignored) {
            // Best effort, including at shutdown. There is no queue or worker to drain.
        }
    }

    public void storageCloseFailed() {
        emit(Signal.CLOSE_FAILED, null, null, false);
    }

    private void emit(Signal signal, String operation, Modes modes, boolean limited) {
        if (logger == null) return;
        try {
            if (!logger.isEnabledForLevel(signal.level)) return;
            long suppressed = limited ? admit(signal) : 0;
            if (suppressed < 0) return;
            var record = logger.atLevel(signal.level)
                    .addKeyValue("event", signal.event)
                    .addKeyValue("instanceId", instance);
            if (signal.reason != null) record.addKeyValue("reason", signal.reason);
            if (operation != null) record.addKeyValue("operation", operation);
            if (signal == Signal.STORAGE_LOST) record.addKeyValue("restartRequired", true);
            if (suppressed != 0) record.addKeyValue("suppressed", suppressed);
            if (modes != null) {
                record.addKeyValue("storageMode", modes.durable() ? "sqlite" : "memory")
                        .addKeyValue("accessMode", modes.protectedAccess() ? "applicationPolicy" : "openDemo")
                        .addKeyValue("sourceCount", modes.sourceCount())
                        .addKeyValue("viewCount", modes.viewCount());
            }
            record.log(signal.message);
        } catch (RuntimeException ignored) {
            // Diagnostics cannot replace the caller's outcome. Never retry through the same sink.
        }
    }

    private synchronized long admit(Signal signal) {
        long now = nanos.getAsLong();
        Bucket bucket = buckets.get(signal);
        if (bucket == null) {
            buckets.put(signal, new Bucket(now));
            return 0;
        }
        return bucket.admit(now);
    }

    static final class Bucket {
        private long emittedAt;
        private long suppressed;

        Bucket(long now) {
            emittedAt = now;
        }

        long admit(long now) {
            if (now - emittedAt < TimeUnit.SECONDS.toNanos(30)) {
                if (suppressed < Long.MAX_VALUE) suppressed++;
                return -1;
            }
            long count = suppressed;
            emittedAt = now;
            suppressed = 0;
            return count;
        }
    }
}
