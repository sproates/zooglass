package io.zooglass.logging;

import ch.qos.logback.classic.Level;
import io.zooglass.access.AccessDecision;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;

import static io.zooglass.logging.ViewerLog.Event.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

class ViewerLogTests {
    @Test
    void gatedBurstsShareAReasonAcrossConnectionsAndAccessOperations() throws Exception {
        try (var capture = new ViewerLogCapture()) {
            var log = capture.operations.viewers();
            capture.logger.setLevel(Level.OFF);
            log.access(ViewerLog.Boundary.HANDSHAKE, AccessDecision.Reason.UNAVAILABLE);
            capture.logger.setLevel(Level.WARN);
            IntStream.range(0, 400).parallel().forEach(i ->
                    log.access(ViewerLog.Boundary.SNAPSHOT, AccessDecision.Reason.UNAVAILABLE));
            assertThat(capture.next("access.unavailable")).containsEntry("operation", "snapshot")
                    .doesNotContainKey("suppressed");
            capture.now.set(TimeUnit.SECONDS.toNanos(30));
            log.access(ViewerLog.Boundary.RENEWAL, AccessDecision.Reason.UNAVAILABLE);
            assertThat(capture.next("access.unavailable")).containsEntry("operation", "renewal")
                    .containsEntry("suppressed", 399L);

            IntStream.range(0, 400).parallel().forEach(i -> log.socket(WRITE, log.newConnection()));
            assertThat(capture.next("delivery.close_requested")).doesNotContainKey("suppressed");
            capture.now.addAndGet(TimeUnit.SECONDS.toNanos(30));
            log.socket(WRITE, log.newConnection());
            assertThat(capture.next("delivery.close_requested")).containsEntry("suppressed", 399L);
            assertThat(capture.records).isEmpty();
        }
    }

    @Test
    void deferredMailboxCoalescesByReasonWhileSinkIsBlockedAndDropsWaitingOnClose() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var blockedAgain = new CountDownLatch(1);
        var releaseAgain = new CountDownLatch(1);
        var received = new LinkedBlockingQueue<Long>();
        var stopped = new CountDownLatch(1);
        var mailbox = new DeferredViewerEvents((event, reference, count) -> {
            if (event == OPEN) {
                entered.countDown();
                await(release);
            } else if (event == FULL) {
                blockedAgain.countDown();
                await(releaseAgain);
                stopped.countDown();
            }
            received.add(count);
        });
        try {
            mailbox.offer(OPEN, null);
            assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
            IntStream.range(0, 400).parallel().forEach(i -> mailbox.offer(WRITE, null));
            mailbox.offer(FULL, null);
            release.countDown();
            assertThat(received.poll(3, TimeUnit.SECONDS)).isEqualTo(1L);
            assertThat(received.poll(3, TimeUnit.SECONDS)).isEqualTo(400L);
            assertThat(blockedAgain.await(3, TimeUnit.SECONDS)).isTrue();
            mailbox.offer(TOO_LARGE, null);
            mailbox.close();
            mailbox.offer(INVALID, null);
            releaseAgain.countDown();
            assertThat(stopped.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(received.poll(3, TimeUnit.SECONDS)).isEqualTo(1L);
            assertThat(received.poll(100, TimeUnit.MILLISECONDS)).isNull();
        } finally {
            release.countDown();
            releaseAgain.countDown();
            mailbox.close();
        }
    }

    @Test
    void weightedAdmissionCarriesCurrentBatchRemainderAndSaturates() {
        long window = TimeUnit.SECONDS.toNanos(30);
        var bucket = new OperationalLog.Bucket(0, 5);
        assertThat(bucket.admit(0, Long.MAX_VALUE)).isEqualTo(-1);
        assertThat(bucket.admit(window, 20)).isEqualTo(Long.MAX_VALUE);
        assertThat(bucket.admit(window, 7)).isEqualTo(-1);
        assertThat(bucket.admit(2 * window, 1)).isEqualTo(26);
    }

    @Test
    void throwingLoggerCannotChangeViewerOutcomesAndNoOpAllocatesNoReference() {
        var logger = mock(org.slf4j.Logger.class);
        when(logger.isEnabledForLevel(org.slf4j.event.Level.WARN)).thenThrow(new IllegalStateException("SENTINEL"));
        var log = new ViewerLog(logger, "owned", () -> { throw new AssertionError("disabled clock"); });
        try {
            log.access(ViewerLog.Boundary.SNAPSHOT, AccessDecision.Reason.UNAVAILABLE);
            log.socket(WRITE, log.newConnection());
            assertThat(ViewerLog.NONE.newConnection()).isNull();
            ViewerLog.NONE.deferred(WRITE, null);
            verify(logger, times(2)).isEnabledForLevel(org.slf4j.event.Level.WARN);
        } finally {
            log.close();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("Logging barrier timed out");
        } catch (InterruptedException interrupted) {
            throw new AssertionError(interrupted);
        }
    }
}
