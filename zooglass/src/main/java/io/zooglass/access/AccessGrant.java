package io.zooglass.access;

import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/** Process-local evidence. An identity-only grant never permits a resource read. */
public final class AccessGrant {

    private final String tenant;
    private final String subject;
    private final ViewResource resource;
    private final long startedNanos;
    private final long lifetimeNanos;
    private final LongSupplier clock;

    AccessGrant(String tenant, String subject, ViewResource resource,
            long startedNanos, long lifetimeMillis, LongSupplier clock) {
        this.tenant = tenant;
        this.subject = subject;
        this.resource = resource;
        this.startedNanos = startedNanos;
        this.lifetimeNanos = TimeUnit.MILLISECONDS.toNanos(Math.min(5000, lifetimeMillis));
        this.clock = clock;
    }

    public String tenant() {
        return tenant;
    }

    public String subject() {
        return subject;
    }

    public ViewResource resource() {
        return resource;
    }

    public boolean isCurrent() {
        // Subtraction also handles System.nanoTime wrapping during a short-lived grant.
        long elapsed = clock.getAsLong() - startedNanos;
        return elapsed >= 0 && elapsed < lifetimeNanos;
    }

    boolean renewalDue() {
        long elapsed = clock.getAsLong() - startedNanos;
        return elapsed < 0 || elapsed >= lifetimeNanos / 2;
    }

    public boolean permits(ViewResource requested) {
        return resource != null && resource.equals(requested) && isCurrent();
    }
}
