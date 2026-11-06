package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.web.socket.WebSocketSession;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

class ActiveViewGrantsTests {

    private static final ViewResource FIRST = new ViewResource("orders", "42");
    private static final ViewResource SECOND = new ViewResource("orders", "43");
    private final AtomicLong clock = new AtomicLong();
    private final WebSocketSession socket = mock(WebSocketSession.class);
    private final List<WebSocketSession> lost = new ArrayList<>();
    private final ViewerCredential credential = ViewerCredential.read(List.of("Bearer opaque"), List.of(), "session");
    private final AdmissionAccess access = new AdmissionAccess(
            new ApplicationPolicyAccess("tenant-a", (token, resource) ->
                    new PolicyReply(PolicyReply.Outcome.ALLOW, "operator", 1000), clock::get),
            "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
    private final ActiveViewGrants grants = new ActiveViewGrants(access, lost::add);

    private void subscribe(ViewResource resource) {
        grants.register(socket, new ViewerHandshake.Identity(credential, "operator"));
        assertThat(grants.admit(socket, resource, grant(resource))).isTrue();
    }

    private AccessGrant grant(ViewResource resource) {
        return new AccessGrant("tenant-a", "operator", resource, clock.get(), 1000, clock::get);
    }

    private void atMillis(long millis) {
        clock.set(TimeUnit.MILLISECONDS.toNanos(millis));
    }

    @Test
    void renewsHalfwayThroughLifetimeWithoutSourceEventsOrDuplicateWork() {
        subscribe(FIRST);
        atMillis(499);
        assertThat(grants.due()).isEmpty();
        atMillis(500);
        var work = grants.due();
        assertThat(work).hasSize(1);
        assertThat(grants.due()).isEmpty();
        grants.renew(work.getFirst());

        atMillis(999);
        assertThat(grants.due()).isEmpty();
        atMillis(1000);
        assertThat(grants.due()).hasSize(1);
        assertThat(lost).isEmpty();
    }

    @ParameterizedTest
    @EnumSource(AccessDecision.Reason.class)
    void failedRenewalInvalidatesTheWholeSocketAndNotOtherViewers(AccessDecision.Reason reason) {
        subscribe(FIRST);
        subscribe(SECOND);
        var other = mock(WebSocketSession.class);
        atMillis(500);
        var work = grants.due();
        grants.register(other, new ViewerHandshake.Identity(credential, "operator"));
        assertThat(grants.admit(other, FIRST, grant(FIRST))).isTrue();
        grants.complete(work.getFirst(), new AccessDecision.Rejected(reason));
        grants.complete(work.getLast(), new AccessDecision.Granted(grant(SECOND)));
        assertThat(lost).containsExactly(socket);
        assertThat(grants.admit(socket, FIRST, grant(FIRST))).isFalse();
        atMillis(1000);
        assertThat(grants.due()).hasSize(1);
    }

    @Test
    void aLateAllowCannotReviveAnExpiredGrantEvenBeforeTheExpirySweep() {
        subscribe(FIRST);
        atMillis(500);
        var renewal = grants.due().getFirst();
        atMillis(1000);
        grants.complete(renewal, new AccessDecision.Granted(grant(FIRST)));
        assertThat(lost).containsExactly(socket);
        assertThat(grants.due()).isEmpty();
    }

    @Test
    void aNewSubscriptionCannotHideExpiryOfAnExistingGrant() {
        subscribe(FIRST);
        atMillis(1000);
        assertThat(grants.admit(socket, SECOND, grant(SECOND))).isFalse();
        assertThat(lost).containsExactly(socket);
        assertThat(grants.due()).isEmpty();
    }

    @Test
    void unsubscribeCannotHideAnExpiredGrantBeforeTheSweep() {
        subscribe(FIRST);
        subscribe(SECOND);
        atMillis(1000);
        grants.remove(socket, FIRST);
        assertThat(lost).containsExactly(socket);
        assertThat(grants.due()).isEmpty();
    }

    @Test
    void policyExceptionsFailClosed() {
        var failingAccess = new AdmissionAccess(new ApplicationPolicyAccess("tenant-a",
                (token, resource) -> { throw new IllegalStateException("Unavailable"); }, clock::get),
                "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
        var failing = new ActiveViewGrants(failingAccess, lost::add);
        failing.register(socket, new ViewerHandshake.Identity(credential, "operator"));
        assertThat(failing.admit(socket, FIRST, grant(FIRST))).isTrue();
        atMillis(500);
        failing.renew(failing.due().getFirst());
        assertThat(lost).containsExactly(socket);
    }

    @Test
    void expiryIsObservedDuringSilenceWhileRenewalIsOutstanding() {
        subscribe(FIRST);
        subscribe(SECOND);
        atMillis(500);
        var work = grants.due();
        atMillis(1000);
        assertThat(grants.due()).isEmpty();
        assertThat(lost).containsExactly(socket);
        work.forEach(renewal -> grants.complete(renewal, new AccessDecision.Granted(grant(FIRST))));
        assertThat(lost).containsExactly(socket);
    }

    @Test
    void replacingAResourceDiscardsBothOldAllowAndOldDenialReplies() {
        subscribe(FIRST);
        atMillis(500);
        var old = grants.due().getFirst();
        assertThat(grants.admit(socket, FIRST, grant(FIRST))).isTrue();
        grants.complete(old, new AccessDecision.Granted(grant(SECOND)));
        grants.complete(old, new AccessDecision.Rejected(AccessDecision.Reason.DENIED));
        assertThat(lost).isEmpty();
        atMillis(1000);
        assertThat(grants.due()).hasSize(1);
    }

    @Test
    void unsubscribeAndDisconnectDiscardOutstandingReplies() {
        subscribe(FIRST);
        atMillis(500);
        var old = grants.due().getFirst();
        grants.remove(socket, FIRST);
        grants.complete(old, new AccessDecision.Rejected(AccessDecision.Reason.DENIED));
        assertThat(lost).isEmpty();
        assertThat(grants.due()).isEmpty();

        subscribe(FIRST);
        atMillis(1000);
        old = grants.due().getFirst();
        grants.remove(socket);
        grants.complete(old, new AccessDecision.Granted(grant(FIRST)));
        assertThat(grants.admit(socket, FIRST, grant(FIRST))).isFalse();
        assertThat(lost).isEmpty();
    }

    @Test
    void renewalCannotChangeSubjectTenantOrResource() {
        for (var changed : List.of(
                new AccessGrant("tenant-b", "operator", FIRST, 0, 1000, clock::get),
                new AccessGrant("tenant-a", "someone-else", FIRST, 0, 1000, clock::get),
                new AccessGrant("tenant-a", "operator", SECOND, 0, 1000, clock::get))) {
            atMillis(0);
            subscribe(FIRST);
            atMillis(500);
            grants.complete(grants.due().getFirst(), new AccessDecision.Granted(changed));
            assertThat(grants.admit(socket, FIRST, grant(FIRST))).isFalse();
        }
        assertThat(lost).hasSize(3);
    }

    @Test
    void shutdownForgetsCredentialsAndCannotBeReopenedByAnOutstandingReply() {
        subscribe(FIRST);
        atMillis(500);
        var old = grants.due().getFirst();
        grants.close();
        grants.register(socket, new ViewerHandshake.Identity(credential, "operator"));
        grants.complete(old, new AccessDecision.Granted(grant(FIRST)));
        assertThat(grants.admit(socket, FIRST, grant(FIRST))).isFalse();
        assertThat(grants.due()).isEmpty();
        assertThat(lost).isEmpty();
    }

    @Test
    void callbacksDoNotHoldTheGrantMonitor() {
        // The callback must enter the same registry from another thread.
        var holder = new ActiveViewGrants[1];
        holder[0] = new ActiveViewGrants(access, session -> {
            try {
                CompletableFuture.runAsync(() -> holder[0].remove(session)).get(1, TimeUnit.SECONDS);
            } catch (Exception failure) {
                throw new AssertionError(failure);
            }
        });
        holder[0].register(socket, new ViewerHandshake.Identity(credential, "operator"));
        assertThat(holder[0].admit(socket, FIRST, grant(FIRST))).isTrue();
        atMillis(1000);
        assertThat(holder[0].due()).isEmpty();
    }
}
