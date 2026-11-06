package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

class GrantReleaseTests {

    @Test
    void deadlineAtReleaseInvalidatesWithoutWaitingForTheTimer() {
        try (var fixture = new ReleaseFixture()) {
            var session = mock(WebSocketSession.class);
            var lease = fixture.admit(session);
            fixture.atMillis(999);
            var handed = new AtomicInteger();
            assertThat(fixture.grants.release(lease, handed::incrementAndGet)).isTrue();
            fixture.atMillis(1000);
            assertThat(fixture.grants.release(lease, handed::incrementAndGet)).isFalse();
            assertThat(handed.get()).isEqualTo(1);
            assertThat(fixture.losses).containsExactly(session);
        }
    }

    @Test
    void replacementAndUnsubscribeInvalidateCapturedFramesButNotTheConnection() {
        try (var fixture = new ReleaseFixture()) {
            var session = mock(WebSocketSession.class);
            var old = fixture.admit(session);
            var current = fixture.admit(session);
            assertThat(fixture.grants.superseded(old)).isTrue();
            assertThat(fixture.grants.release(old, () -> { throw new AssertionError("Old generation sent"); })).isFalse();
            assertThat(fixture.grants.release(current, () -> {})).isTrue();
            fixture.grants.remove(session, ReleaseFixture.RESOURCE);
            assertThat(fixture.grants.release(current, () -> { throw new AssertionError("Unsubscribed frame sent"); })).isFalse();
            assertThat(fixture.grants.release(fixture.grants.capture(session, null), () -> {})).isTrue();
            assertThat(fixture.losses).isEmpty();
        }
    }

    @Test
    void renewalUpdatesTheGrantOfAlreadyQueuedFrames() {
        try (var fixture = new ReleaseFixture()) {
            var lease = fixture.admit(mock(WebSocketSession.class));
            fixture.atMillis(500);
            fixture.renew();
            fixture.atMillis(1000);
            assertThat(fixture.grants.release(lease, () -> {})).isTrue();
            fixture.atMillis(1500);
            assertThat(fixture.grants.release(lease, () -> {})).isFalse();
        }
    }

    @Test
    void repeatDenialInvalidatesDataAndControlFramesOnlyForThatConnection() {
        try (var fixture = new ReleaseFixture()) {
            var first = mock(WebSocketSession.class);
            var other = mock(WebSocketSession.class);
            var data = fixture.admit(first);
            var control = fixture.grants.capture(first, null);
            var healthy = fixture.admit(other);
            assertThat(fixture.grants.refuse(first, ReleaseFixture.RESOURCE)).isTrue();
            for (var frame : java.util.List.of(data, control)) {
                assertThat(fixture.grants.release(frame, () -> { throw new AssertionError("Revoked frame sent"); })).isFalse();
            }
            assertThat(fixture.grants.release(healthy, () -> {})).isTrue();
            assertThat(fixture.losses).containsExactly(first);
            assertThat(fixture.grants.release(null, () -> {})).isFalse();
            fixture.close();
            assertThat(fixture.grants.release(healthy, () -> {})).isFalse();
        }
    }

    @Test
    void invalidationIsOrderedWithHandoff() throws Exception {
        try (var fixture = new ReleaseFixture()) {
            var session = mock(WebSocketSession.class);
            var lease = fixture.admit(session);
            var enteringTransport = new CountDownLatch(1);
            var finishSubmission = new CountDownLatch(1);
            var invalidating = new CountDownLatch(1);
            var handoff = CompletableFuture.supplyAsync(() -> fixture.grants.release(lease, () -> {
                enteringTransport.countDown();
                try {
                    if (!finishSubmission.await(3, TimeUnit.SECONDS)) throw new AssertionError("Submission stalled");
                } catch (InterruptedException interrupted) {
                    throw new AssertionError(interrupted);
                }
            }));
            assertThat(enteringTransport.await(2, TimeUnit.SECONDS)).isTrue();
            var refusal = CompletableFuture.supplyAsync(() -> {
                invalidating.countDown();
                return fixture.grants.refuse(session, ReleaseFixture.RESOURCE);
            });
            try {
                assertThat(invalidating.await(2, TimeUnit.SECONDS)).isTrue();
                assertThat(refusal.isDone()).isFalse();
            } finally {
                finishSubmission.countDown();
            }
            assertThat(handoff.get(2, TimeUnit.SECONDS)).isTrue();
            assertThat(refusal.get(2, TimeUnit.SECONDS)).isTrue();
            assertThat(fixture.grants.release(lease, () -> {})).isFalse();
        }
    }
}
