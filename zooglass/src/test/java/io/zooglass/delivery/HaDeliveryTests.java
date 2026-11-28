package io.zooglass.delivery;

import io.zooglass.access.ActiveViewGrants;
import io.zooglass.access.ReleaseFixture;
import io.zooglass.runtime.RuntimeConfiguration.Delivery;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

class HaDeliveryTests {
    @ParameterizedTest
    @ValueSource(strings = {"expire", "refuse", "replaceGrant", "replaceMembership"})
    void captureTakenByWriterCannotCrossCutoffAtNativeSubmission(String cutoff) throws Exception {
        try (var fixture = new ReleaseFixture()) {
            var socket = new NativeWriterSocket();
            var original = fixture.admit(socket.viewer);
            var membership = new AtomicBoolean(true);
            var permitEntered = new CountDownLatch(1);
            var permitReturned = new CountDownLatch(1);
            var drained = new CountDownLatch(1);
            var failures = new LinkedBlockingQueue<Integer>();
            var writer = new HaDelivery(new Delivery(null), socket.viewer, fixture.grants, failures::add);
            try {
                writer.start();
                writer.batch(List.of(new HaDelivery.Pending(64, original, membership::get, () -> {
                    permitEntered.countDown();
                    await(permitReturned);
                    return "captured on old membership";
                }), new HaDelivery.Pending(16, null, () -> true, () -> {
                    drained.countDown();
                    return "barrier";
                })));
                await(permitEntered);
                switch (cutoff) {
                    case "expire" -> fixture.atMillis(1000);
                    case "refuse" -> fixture.grants.refuse(socket.viewer, ReleaseFixture.RESOURCE);
                    case "replaceGrant" -> fixture.admit(socket.viewer);
                    case "replaceMembership" -> membership.set(false);
                    default -> throw new AssertionError(cutoff);
                }
                permitReturned.countDown();
                await(drained);
                assertThat(socket.sent).isEmpty();
                assertThat(failures).isEmpty();
                if (cutoff.equals("expire") || cutoff.equals("refuse")) {
                    assertThat(fixture.losses.poll(2, TimeUnit.SECONDS)).isSameAs(socket.viewer);
                }
            } finally {
                permitReturned.countDown();
                writer.stop();
            }
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"disconnectOnOverflow", "coalesceLatestState"})
    void openingBatchPrecedesOrdinaryUpdatesEvenWhileTheFirstWriteIsOutstanding(String policy) throws Exception {
        try (var fixture = new ReleaseFixture()) {
            var socket = new NativeWriterSocket();
            var lease = fixture.admit(socket.viewer);
            var failures = new LinkedBlockingQueue<Integer>();
            var writer = new HaDelivery(new Delivery(null, SlowClientPolicy.select(policy), 8, 2048L),
                    socket.viewer, fixture.grants, failures::add);
            try {
                writer.start();
                writer.batch(List.of(frame("subscribed", lease), frame("baseline", lease)));
                var opening = socket.next();
                assertThat(opening.payload()).isEqualTo("subscribed");
                writer.update(1, frame("first update", lease));
                writer.update(1, frame("second update", lease));
                opening.finish();
                var baseline = socket.next();
                assertThat(baseline.payload()).isEqualTo("baseline");
                baseline.finish();
                if (policy.equals("disconnectOnOverflow")) {
                    var first = socket.next();
                    assertThat(first.payload()).isEqualTo("first update");
                    first.finish();
                }
                var last = socket.next();
                assertThat(last.payload()).isEqualTo("second update");
                last.finish();
                assertThat(failures).isEmpty();
            } finally {
                writer.stop();
            }
        }
    }

    @Test
    void failedPermitStopsTheWriterBeforeAnyFollowingCaptureCanBeAdmitted() throws Exception {
        try (var fixture = new ReleaseFixture()) {
            var socket = new NativeWriterSocket();
            var lease = fixture.admit(socket.viewer);
            var requestedCloses = new LinkedBlockingQueue<Integer>();
            var later = new AtomicBoolean();
            var writer = new HaDelivery(new Delivery(null), socket.viewer, fixture.grants, requestedCloses::add);
            try {
                writer.batch(List.of(new HaDelivery.Pending(16, lease, () -> true, () -> {
                    throw new IllegalStateException("Lost ownership during admission");
                }), new HaDelivery.Pending(16, lease, () -> true, () -> {
                    later.set(true);
                    return "later";
                })));
                writer.start();
                assertThat(requestedCloses.poll(2, TimeUnit.SECONDS)).isEqualTo(1013);
                assertThat(socket.sent).isEmpty();
                assertThat(later).isFalse();
            } finally {
                writer.stop();
            }
        }
    }

    private static HaDelivery.Pending frame(String body, ActiveViewGrants.Lease lease) {
        return new HaDelivery.Pending(64, lease, () -> true, () -> body);
    }

    private static void await(CountDownLatch barrier) {
        try {
            assertThat(barrier.await(3, TimeUnit.SECONDS)).as("controlled writer barrier").isTrue();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }
}
