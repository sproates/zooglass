package io.zooglass.access;

import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** One expiry sweep and bounded, unqueued policy work, separate from publication and writers. */
public final class GrantRenewals implements AutoCloseable {

    private final ActiveViewGrants grants;
    private final ThreadPoolExecutor workers;
    private final ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(1,
            Thread.ofPlatform().daemon().name("zooglass-access-expiry").factory());

    public GrantRenewals(ActiveViewGrants grants) {
        this(grants, 32);
    }

    GrantRenewals(ActiveViewGrants grants, int maxConcurrent) {
        this.grants = grants;
        workers = new ThreadPoolExecutor(maxConcurrent, maxConcurrent, 0, TimeUnit.SECONDS,
                new SynchronousQueue<>(), Thread.ofVirtual().name("zooglass-access-renewal-", 0).factory());
        timer.scheduleWithFixedDelay(this::sweep, 25, 25, TimeUnit.MILLISECONDS);
    }

    private void sweep() {
        for (var renewal : grants.due()) {
            try {
                workers.execute(() -> grants.renew(renewal));
            } catch (RejectedExecutionException unavailable) {
                grants.complete(renewal, new AccessDecision.Rejected(AccessDecision.Reason.UNAVAILABLE));
            }
        }
    }

    @Override
    public void close() {
        grants.close();
        timer.shutdownNow();
        workers.shutdownNow();
    }
}
