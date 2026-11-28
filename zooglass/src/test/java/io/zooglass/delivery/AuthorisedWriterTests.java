package io.zooglass.delivery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.zooglass.access.ActiveViewGrants;
import io.zooglass.access.ReleaseFixture;
import io.zooglass.runtime.RuntimeConfiguration.Delivery;

import jakarta.websocket.SendHandler;
import jakarta.websocket.SendResult;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

class AuthorisedWriterTests {

    private static OutboundQueue.Frame frame(String payload, ActiveViewGrants.Lease lease) {
        return new OutboundQueue.Frame(payload).forLease(lease);
    }

    @ParameterizedTest
    @ValueSource(strings = {"expire", "replace", "unsubscribe", "deny"})
    void aFrameTakenBeforeInvalidationCannotReachTheTransport(String action) throws Exception {
        try (var fixture = new ReleaseFixture(); var executor = new SocketDeliveryDriver()) {
            var socket = new NativeWriterSocket();
            var lease = fixture.admit(socket.viewer);
            var taken = new CountDownLatch(1);
            var resume = new CountDownLatch(1);
            var first = new AtomicBoolean(true);
            var afterTakenFrame = new CountDownLatch(1);
            when(socket.nativeSession.getAsyncRemote()).thenAnswer(call -> {
                if (first.getAndSet(false)) {
                    taken.countDown();
                    if (!resume.await(3, TimeUnit.SECONDS)) throw new AssertionError("Writer not resumed");
                } else {
                    afterTakenFrame.countDown();
                }
                return socket.remote;
            });
            var failures = new LinkedBlockingQueue<Exception>();
            var writer = new OutboundWriter(socket.viewer, executor, new Delivery(null),
                    (ignored, error) -> failures.add(error), fixture.grants);
            try {
                writer.enqueueProtected(List.of(frame("obsolete", lease)));
                assertThat(taken.await(2, TimeUnit.SECONDS)).isTrue();
                switch (action) {
                    case "expire" -> fixture.atMillis(1000);
                    case "replace" -> fixture.admit(socket.viewer);
                    case "unsubscribe" -> fixture.grants.remove(socket.viewer, ReleaseFixture.RESOURCE);
                    case "deny" -> fixture.grants.refuse(socket.viewer, ReleaseFixture.RESOURCE);
                    default -> throw new AssertionError(action);
                }
                resume.countDown();
                if (action.equals("expire") || action.equals("deny")) {
                    writer.enqueueProtected(List.of(frame("probe", null)));
                    assertThat(afterTakenFrame.await(2, TimeUnit.SECONDS)).isTrue();
                    assertThat(fixture.losses.poll(2, TimeUnit.SECONDS)).isEqualTo(socket.viewer);
                } else {
                    writer.enqueueProtected(List.of(frame("control", fixture.grants.capture(socket.viewer, null))));
                    var control = socket.next();
                    assertThat(control.payload()).isEqualTo("control");
                    control.finish();
                }
                assertThat(socket.sent).isEmpty();
                assertThat(failures).isEmpty();
            } finally {
                resume.countDown();
                writer.stop();
            }
        }
    }

    @Test
    void networkCompletionDoesNotHoldGrantLocksOrBlockAnotherViewer() throws Exception {
        try (var fixture = new ReleaseFixture(); var executor = new SocketDeliveryDriver()) {
            var slow = new NativeWriterSocket();
            var healthy = new NativeWriterSocket();
            var slowLease = fixture.admit(slow.viewer);
            var healthyLease = fixture.admit(healthy.viewer);
            var failures = new LinkedBlockingQueue<Exception>();
            var afterWaiting = new CountDownLatch(1);
            var accesses = new java.util.concurrent.atomic.AtomicInteger();
            when(slow.nativeSession.getAsyncRemote()).thenAnswer(call -> {
                if (accesses.incrementAndGet() == 3) afterWaiting.countDown();
                return slow.remote;
            });
            var writer = new OutboundWriter(slow.viewer, executor, new Delivery(null),
                    (ignored, error) -> failures.add(error), fixture.grants);
            var other = new OutboundWriter(healthy.viewer, executor, new Delivery(null),
                    (ignored, error) -> failures.add(error), fixture.grants);
            try {
                writer.enqueueProtected(List.of(frame("already handed off", slowLease), frame("waiting", slowLease),
                        frame("control", fixture.grants.capture(slow.viewer, null))));
                var outstanding = slow.next();
                assertThat(CompletableFuture.supplyAsync(() -> fixture.grants.refuse(slow.viewer, ReleaseFixture.RESOURCE))
                        .get(1, TimeUnit.SECONDS)).isTrue();
                other.enqueueProtected(List.of(frame("healthy", healthyLease)));
                var delivered = healthy.next();
                assertThat(delivered.payload()).isEqualTo("healthy");
                delivered.finish();
                outstanding.finish();
                assertThat(afterWaiting.await(2, TimeUnit.SECONDS)).isTrue();
                assertThat(slow.sent).isEmpty();
                assertThat(failures).isEmpty();
            } finally {
                writer.stop();
                other.stop();
            }
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"disconnectOnOverflow", "coalesceLatestState"})
    void replacementDiscardsQueuedOldGenerationBeforeAdmittingNewBaseline(String policy) throws Exception {
        try (var fixture = new ReleaseFixture(); var executor = new SocketDeliveryDriver()) {
            var socket = new NativeWriterSocket();
            var old = fixture.admit(socket.viewer);
            var failures = new LinkedBlockingQueue<Exception>();
            var writer = new OutboundWriter(socket.viewer, executor,
                    new Delivery(null, SlowClientPolicy.select(policy), 2, 4096L),
                    (ignored, error) -> failures.add(error), fixture.grants);
            try {
                writer.enqueueProtected(List.of(frame("in flight", old)));
                var outstanding = socket.next();
                writer.enqueueUpdate(1, frame("old update", old));
                writer.enqueueProtected(List.of(frame("old baseline", old)));
                var replacement = fixture.admit(socket.viewer);
                assertThat(writer.enqueueProtected(List.of(frame("ack", replacement), frame("baseline", replacement))))
                        .isEqualTo(OutboundQueue.Admission.ACCEPTED);
                outstanding.finish();
                var ack = socket.next();
                assertThat(ack.payload()).isEqualTo("ack");
                ack.finish();
                var baseline = socket.next();
                assertThat(baseline.payload()).isEqualTo("baseline");
                baseline.finish();
                assertThat(socket.sent).isEmpty();
                assertThat(failures).isEmpty();
            } finally {
                writer.stop();
            }
        }
    }

    @Test
    void asynchronousTransportFailureReachesWriterCleanup() throws Exception {
        try (var fixture = new ReleaseFixture(); var executor = new SocketDeliveryDriver()) {
            var socket = new NativeWriterSocket();
            var lease = fixture.admit(socket.viewer);
            var failures = new LinkedBlockingQueue<Exception>();
            var writer = new OutboundWriter(socket.viewer, executor, new Delivery(null),
                    (ignored, error) -> failures.add(error), fixture.grants);
            try {
                writer.enqueueProtected(List.of(frame("payload", lease)));
                socket.next().completion().onResult(new SendResult(new IOException("broken transport")));
                assertThat(failures.poll(2, TimeUnit.SECONDS)).isInstanceOf(IOException.class);
            } finally {
                writer.stop();
            }
        }
    }

    @Test
    void aLeaseCannotBeSentThroughAnotherViewersTransport() throws Exception {
        try (var fixture = new ReleaseFixture()) {
            var owner = new NativeWriterSocket();
            var other = new NativeWriterSocket();
            var lease = fixture.admit(owner.viewer);
            fixture.admit(other.viewer);
            doAnswer(call -> {
                var sent = new NativeWriterSocket.Sent(call.getArgument(0), call.getArgument(1));
                other.sent.add(sent);
                sent.finish();
                return null;
            }).when(other.remote).sendText(anyString(), any(SendHandler.class));
            new AuthorisedSocketTransport(other.viewer, fixture.grants).send(frame("wrong viewer", lease));
            assertThat(other.sent).isEmpty();
        }
    }

    @Test
    void unsupportedTransportCannotFallBackToABlockingProtectedSend() {
        try (var fixture = new ReleaseFixture()) {
            assertThatThrownBy(() -> new AuthorisedSocketTransport(mock(WebSocketSession.class), fixture.grants))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }
}
