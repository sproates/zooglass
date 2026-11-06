package io.zooglass.access;

import org.springframework.web.socket.WebSocketSession;

import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Real grants with a controlled clock, shared by registry and transport boundary tests. */
public final class ReleaseFixture implements AutoCloseable {
    public static final ViewResource RESOURCE = new ViewResource("orders", "42");
    public final AtomicLong clock = new AtomicLong();
    public final LinkedBlockingQueue<WebSocketSession> losses = new LinkedBlockingQueue<>();
    private final ViewerCredential credential = ViewerCredential.read(List.of("Bearer opaque"), List.of(), "session");
    private final AdmissionAccess access = new AdmissionAccess(new ApplicationPolicyAccess("tenant-a",
            (token, resource) -> new PolicyReply(PolicyReply.Outcome.ALLOW, "operator", 1000), clock::get),
            "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
    public final ActiveViewGrants grants = new ActiveViewGrants(access, losses::add);

    public ActiveViewGrants.Lease admit(WebSocketSession session) {
        grants.register(session, new ViewerHandshake.Identity(credential, "operator"));
        var grant = new AccessGrant("tenant-a", "operator", RESOURCE, clock.get(), 1000, clock::get);
        if (!grants.admit(session, RESOURCE, grant)) throw new AssertionError("Admission refused");
        return grants.capture(session, RESOURCE);
    }

    public void atMillis(long millis) {
        clock.set(TimeUnit.MILLISECONDS.toNanos(millis));
    }

    public void renew() {
        grants.due().forEach(grants::renew);
    }

    @Override
    public void close() {
        grants.close();
        access.close();
    }
}
