package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

class GrantRenewalsTests {

    @Test
    void blockedPolicyWorkIsBoundedAndDoesNotStopExpiry() throws Exception {
        var clock = new AtomicLong();
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var calls = new AtomicInteger();
        var losses = new LinkedBlockingQueue<WebSocketSession>();
        var resource = new ViewResource("orders", "42");
        var credential = ViewerCredential.read(List.of("Bearer opaque"), List.of(), "session");
        var access = new AdmissionAccess(new ApplicationPolicyAccess("tenant-a", (token, requested) -> {
            calls.incrementAndGet();
            entered.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Policy not released");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return new PolicyReply(PolicyReply.Outcome.ALLOW, "operator", 1000);
        }, clock::get), "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
        var grants = new ActiveViewGrants(access, losses::add);
        for (int i = 0; i < 3; i++) {
            var socket = mock(WebSocketSession.class);
            grants.register(socket, new ViewerHandshake.Identity(credential, "operator"));
            assertThat(grants.admit(socket, resource,
                    new AccessGrant("tenant-a", "operator", resource, 0, 1000, clock::get))).isTrue();
        }
        clock.set(TimeUnit.MILLISECONDS.toNanos(500));
        try (var renewals = new GrantRenewals(grants, 1)) {
            assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(losses.poll(2, TimeUnit.SECONDS)).isNotNull();
            assertThat(losses.poll(2, TimeUnit.SECONDS)).isNotNull();
            assertThat(calls.get()).isEqualTo(1);
            clock.set(TimeUnit.MILLISECONDS.toNanos(1000));
            assertThat(losses.poll(2, TimeUnit.SECONDS)).isNotNull();
            assertThat(losses).isEmpty();
        } finally {
            release.countDown();
        }
        assertThat(grants.due()).isEmpty();
    }
}
