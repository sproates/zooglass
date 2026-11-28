package io.zooglass.runtime;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;

import java.sql.SQLException;
import java.sql.SQLNonTransientException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Function;

/** One candidate and one JDBC operation at a time, including probe cancellation and retirement. */
@Component
@HaDeployment
final class HaOwner {
    private final HaSettings settings;
    private final Semaphore gate = new Semaphore(1, true);
    private final java.util.concurrent.ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(
            Thread.ofPlatform().daemon().name("zooglass-ha-candidate").factory());
    private final CopyOnWriteArrayList<Consumer<OwnedRuntime>> retirements = new CopyOnWriteArrayList<>();
    private volatile OwnedRuntime active;
    private volatile boolean stopped;

    HaOwner(HaSettings settings) { this.settings = settings; }

    @PostConstruct
    void start() { timer.execute(this::tick); }

    private void tick() {
        gate.acquireUninterruptibly();
        try {
            if (stopped) return;
            if (active != null) {
                active.renew();
            } else {
                var candidate = ViewCoordinator.postgres(settings.profile, settings::connect, settings.lease);
                try {
                    candidate.recover();
                    candidate.renew();
                    candidate.activate();
                    active = candidate;
                } catch (RuntimeException failure) {
                    dispose(candidate);
                    throw failure;
                }
            }
        } catch (RuntimeException failure) {
            retire();
            if (permanent(failure)) stopped = true;
        } finally {
            gate.release();
        }
        long delay = active == null ? settings.retryMillis + ThreadLocalRandom.current().nextInt(251) : settings.renewMillis;
        if (!stopped) timer.schedule(this::tick, delay, TimeUnit.MILLISECONDS);
    }

    private static boolean permanent(Throwable cause) {
        for (; cause != null; cause = cause.getCause()) {
            if (cause instanceof ArithmeticException || cause instanceof SQLNonTransientException) return true;
            if (cause instanceof SQLException sql && sql.getSQLState() != null
                    && (sql.getSQLState().startsWith("42") || sql.getSQLState().startsWith("28"))) return true;
        }
        return false;
    }

    <T> T use(OwnedRuntime expected, Function<OwnedRuntime, T> operation) {
        try {
            if (!gate.tryAcquire(5, TimeUnit.SECONDS)) throw unavailable();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw unavailable();
        }
        try {
            var owner = active;
            if (stopped || owner == null || (expected != null && expected != owner)) throw unavailable();
            try {
                return operation.apply(owner);
            } catch (RuntimeException failure) {
                // An exception after commit can interrupt local installation or recipient fanout.
                // Retire every pending handoff and force a fresh capture on a recovered attempt.
                retire();
                if (failure instanceof StorageUnavailable unavailable) throw unavailable;
                throw new StorageUnavailable("Owner operation did not complete", failure);
            }
        } finally {
            gate.release();
        }
    }

    static StorageUnavailable unavailable() { return new StorageUnavailable("No active owner", null); }

    boolean current(OwnedRuntime expected) { return !stopped && active == expected; }

    void onRetirement(Consumer<OwnedRuntime> listener) { retirements.add(listener); }

    private void retire() {
        var previous = active;
        active = null;
        if (previous == null) return;
        try {
            for (var listener : retirements) listener.accept(previous);
        } finally {
            dispose(previous);
        }
    }

    private static void dispose(OwnedRuntime owner) {
        try { owner.close(); } catch (RuntimeException ignored) {
            // No further use of this attempt. Its authority expires on the primary.
        }
    }

    boolean probe(long deadline) {
        if (!gate.tryAcquire()) return false;
        var owner = active;
        if (owner == null || stopped || System.nanoTime() >= deadline) {
            gate.release();
            return false;
        }
        var probe = new Probe(owner, deadline);
        Thread.startVirtualThread(probe::perform);
        try {
            return probe.answer.get(Math.max(0L, deadline - System.nanoTime()), TimeUnit.NANOSECONDS)
                    && System.nanoTime() < deadline;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (java.util.concurrent.ExecutionException | java.util.concurrent.TimeoutException expired) {
            // Only the probe still owning this gate can abort its connection.
        }
        probe.expire();
        return false;
    }

    private final class Probe {
        final OwnedRuntime owner;
        final long deadline;
        final CompletableFuture<Boolean> answer = new CompletableFuture<>();
        CompletableFuture<Void> cancel;

        Probe(OwnedRuntime owner, long deadline) { this.owner = owner; this.deadline = deadline; }

        synchronized void expire() {
            if (answer.isDone() || cancel != null) return;
            cancel = new CompletableFuture<>();
            Thread.startVirtualThread(() -> {
                try { owner.abortProbe(); } finally { cancel.complete(null); }
            });
        }

        void perform() {
            boolean success = false;
            try {
                owner.probe(deadline);
                success = true;
            } catch (RuntimeException unavailable) {
                // A failed or indeterminate check retires the attempt.
            }
            try {
                synchronized (this) {
                    success &= !stopped && cancel == null && System.nanoTime() < deadline;
                    answer.complete(success);
                }
                if (cancel != null) cancel.join();
                if (!success) retire();
            } finally {
                gate.release();
            }
        }
    }

    @PreDestroy
    void close() {
        stopped = true;
        timer.shutdownNow();
        gate.acquireUninterruptibly();
        try { retire(); } finally { gate.release(); }
    }
}
