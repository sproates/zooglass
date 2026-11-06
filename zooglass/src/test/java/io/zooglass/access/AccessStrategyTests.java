package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

class AccessStrategyTests {

    static final ViewResource ORDER = new ViewResource("orders", "42");
    static final ViewerCredential CREDENTIAL = ViewerCredential.read(
            List.of("Bearer caller-token"), List.of(), "session");

    @Test
    void selectionUsesTheNamedStrategiesAndRejectsIncompleteOrMixedSettings() {
        try (var open = AccessStrategySelection.select(AccessStrategySelection.Mode.OPEN_DEMO, null)) {
            assertThat(open).isInstanceOf(OpenDemoAccess.class);
            assertThat(open.authenticate(null)).isInstanceOf(AccessDecision.Open.class);
            assertThat(open.authorise(null, ORDER)).isInstanceOf(AccessDecision.Open.class);
        }
        var settings = settings();
        try (var policy = AccessStrategySelection.select(
                AccessStrategySelection.Mode.APPLICATION_POLICY, settings)) {
            assertThat(policy).isInstanceOf(ApplicationPolicyAccess.class);
            assertThat(policy.authenticate(null))
                    .isEqualTo(new AccessDecision.Rejected(AccessDecision.Reason.UNAUTHENTICATED));
        }
        assertThatThrownBy(() -> AccessStrategySelection.select(null, null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AccessStrategySelection.select(AccessStrategySelection.Mode.OPEN_DEMO, settings))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AccessStrategySelection.select(AccessStrategySelection.Mode.APPLICATION_POLICY, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void grantStartsBeforeThePolicyCallAndBindsTheExactResource() {
        var clock = new AtomicLong();
        PolicyClient client = (credential, resource) -> {
            assertThat(credential).isSameAs(CREDENTIAL);
            assertThat(resource).isEqualTo(ORDER);
            clock.set(TimeUnit.SECONDS.toNanos(2));
            return new PolicyReply(PolicyReply.Outcome.ALLOW, "operator-a", Long.MAX_VALUE);
        };
        try (var access = new ApplicationPolicyAccess("tenant-a", client, clock::get)) {
            var grant = ((AccessDecision.Granted) access.authorise(CREDENTIAL, ORDER)).grant();
            assertThat(grant.tenant()).isEqualTo("tenant-a");
            assertThat(grant.subject()).isEqualTo("operator-a");
            assertThat(grant.permits(ORDER)).isTrue();
            assertThat(grant.permits(new ViewResource("orders", "43"))).isFalse();
            assertThat(grant.permits(new ViewResource("Orders", "42"))).isFalse();
            clock.set(TimeUnit.SECONDS.toNanos(5) - 1);
            assertThat(grant.isCurrent()).isTrue();
            clock.incrementAndGet();
            assertThat(grant.isCurrent()).isFalse();
        }
    }

    @Test
    void identityNeverGrantsAResourceAndShortLifetimesAreRespected() {
        var clock = new AtomicLong();
        PolicyClient client = (credential, resource) -> {
            assertThat(resource).isNull();
            return new PolicyReply(PolicyReply.Outcome.ALLOW, "operator", 20);
        };
        try (var access = new ApplicationPolicyAccess("tenant", client, clock::get)) {
            var grant = ((AccessDecision.Granted) access.authenticate(CREDENTIAL)).grant();
            assertThat(grant.isCurrent()).isTrue();
            assertThat(grant.permits(ORDER)).isFalse();
            clock.set(TimeUnit.MILLISECONDS.toNanos(20));
            assertThat(grant.isCurrent()).isFalse();
        }
    }

    @Test
    void delayedAllowReplyCannotExtendADeadline() {
        var clock = new AtomicLong();
        PolicyClient client = (credential, resource) -> {
            clock.set(TimeUnit.SECONDS.toNanos(6));
            return new PolicyReply(PolicyReply.Outcome.ALLOW, "operator", 5000);
        };
        try (var access = new ApplicationPolicyAccess("tenant", client, clock::get)) {
            assertThat(access.authorise(CREDENTIAL, ORDER))
                    .isEqualTo(new AccessDecision.Rejected(AccessDecision.Reason.UNAVAILABLE));
        }
    }

    @Test
    void failuresStayDistinctAndEveryRequestGetsAFreshDecision() {
        var calls = new AtomicLong();
        PolicyClient client = (credential, resource) -> switch ((int) calls.getAndIncrement()) {
            case 0 -> new PolicyReply(PolicyReply.Outcome.UNAUTHENTICATED, null, 0);
            case 1 -> new PolicyReply(PolicyReply.Outcome.DENY, null, 0);
            default -> PolicyReply.unavailable();
        };
        try (var access = new ApplicationPolicyAccess("tenant", client, System::nanoTime)) {
            assertThat(access.authenticate(null))
                    .isEqualTo(new AccessDecision.Rejected(AccessDecision.Reason.UNAUTHENTICATED));
            assertThat(calls).hasValue(0);
            for (var reason : AccessDecision.Reason.values()) {
                assertThat(access.authorise(CREDENTIAL, ORDER)).isEqualTo(new AccessDecision.Rejected(reason));
            }
            assertThat(calls).hasValue(3);
        }
    }

    @Test
    void monotonicWrapDoesNotExtendTheGrant() {
        var clock = new AtomicLong(Long.MAX_VALUE - 10);
        var grant = new AccessGrant("tenant", "subject", ORDER, clock.get(), 1, clock::get);
        clock.addAndGet(20);
        assertThat(grant.isCurrent()).isTrue();
        clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(1));
        assertThat(grant.isCurrent()).isFalse();
    }

    private PolicySettings settings() {
        return new PolicySettings("tenant", URI.create("https://localhost/decision"),
                "service-token", Duration.ofSeconds(1), 4);
    }
}
