package io.zooglass.logging;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.AppenderBase;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static io.zooglass.logging.OperationalLog.SourceOperation.PROGRESS;
import static io.zooglass.logging.OperationalLog.SourceOperation.PUBLICATION;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class OperationalLogTests {
    private final LoggerContext context = new LoggerContext();

    @AfterEach
    void closeContext() {
        context.stop();
    }

    private static Map<String, Object> fields(ILoggingEvent event) {
        return event.getKeyValuePairs().stream().collect(Collectors.toMap(p -> p.key, p -> p.value));
    }

    @Test
    void disabledLevelsAndConcurrentBurstsDoNotDiscardTheFirstEligibleRecord() {
        var logger = context.getLogger("capture");
        var appender = new ListAppender<ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        var now = new AtomicLong(73);
        var operations = new OperationalLog(logger, "owned", now::get);
        logger.setLevel(Level.OFF);
        operations.processingFailed(PUBLICATION);
        logger.setLevel(Level.ERROR);
        IntStream.range(0, 1000).parallel().forEach(i -> operations.processingFailed(PUBLICATION));
        assertThat(appender.list).hasSize(1);
        now.addAndGet(TimeUnit.SECONDS.toNanos(30) - 1);
        operations.processingFailed(PROGRESS);
        assertThat(appender.list).hasSize(1);
        now.incrementAndGet();
        operations.processingFailed(PROGRESS);
        assertThat(appender.list).hasSize(2);
        assertThat(fields(appender.list.getFirst())).containsExactlyInAnyOrderEntriesOf(Map.of(
                "event", "processing.failed", "reason", "unexpected", "operation", "publication", "instanceId", "owned"));
        assertThat(fields(appender.list.getLast())).containsEntry("suppressed", 1000L).containsEntry("operation", "progress");
        assertThat(appender.list.getLast().getThrowableProxy()).isNull();
    }

    @Test
    void startupAndShutdownDescribeOnlyKnownLifecycleFacts() {
        var logger = context.getLogger("lifecycle");
        var appender = new ListAppender<ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        var failed = new OperationalLog(logger, "one", () -> { throw new AssertionError("one-time event read clock"); });
        failed.startupConfigurationFailed();
        failed.startFailed();
        var running = new OperationalLog(logger, "two", () -> { throw new AssertionError("one-time event read clock"); });
        running.ready(new OperationalLog.Modes(true, false, 1, 3));
        running.startFailed();
        running.stopping();
        assertThat(appender.list).hasSize(3);
        assertThat(fields(appender.list.get(0))).containsEntry("event", "service.start_failed").containsEntry("reason", "configuration");
        assertThat(fields(appender.list.get(1))).containsEntry("event", "service.ready").containsEntry("storageMode", "sqlite")
                .containsEntry("accessMode", "openDemo").containsEntry("sourceCount", 1).containsEntry("viewCount", 3);
        assertThat(fields(appender.list.get(2))).containsOnly(Map.entry("event", "service.stopping"), Map.entry("instanceId", "two"));
    }

    @Test
    void noSinkReadsNoClockAndStartsNoStorageWorker() {
        var clockCalls = new AtomicLong();
        var dispatchCalls = new AtomicLong();
        var disabled = new OperationalLog(null, null, clockCalls::incrementAndGet,
                ignored -> dispatchCalls.incrementAndGet());
        disabled.processingFailed(PUBLICATION);
        disabled.storageLost(OperationalLog.StoreOperation.INSTALL);
        assertThat(clockCalls.get()).isZero();
        assertThat(dispatchCalls.get()).isZero();
    }

    @Test
    void aSinkFailureCannotReplaceTheOriginalFailure() {
        var logger = mock(Logger.class);
        when(logger.isEnabledForLevel(org.slf4j.event.Level.WARN)).thenReturn(true);
        when(logger.atLevel(org.slf4j.event.Level.WARN)).thenThrow(new IllegalStateException("fake sink failure"));
        var operations = new OperationalLog(logger, "owned", () -> 1);
        assertThatCode(() -> operations.receiptTransportFailed(PUBLICATION)).doesNotThrowAnyException();
    }

    @Test
    void aBlockedStorageAppenderDoesNotHoldItsCallersMonitor() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var finished = new CountDownLatch(1);
        var logger = context.getLogger("storage");
        var appender = new AppenderBase<ILoggingEvent>() {
            @Override
            protected void append(ILoggingEvent event) {
                entered.countDown();
                try {
                    release.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                } finally {
                    finished.countDown();
                }
            }
        };
        appender.start();
        logger.addAppender(appender);
        var operations = new OperationalLog(logger, "owned", () -> 0);
        var monitor = new Object();
        var caller = CompletableFuture.runAsync(() -> {
            synchronized (monitor) {
                operations.storageLost(OperationalLog.StoreOperation.INSTALL);
            }
        });
        try {
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
            caller.get(5, TimeUnit.SECONDS);
            synchronized (monitor) {
                assertThat(finished.getCount()).isEqualTo(1);
            }
        } finally {
            release.countDown();
        }
        assertThat(finished.await(5, TimeUnit.SECONDS)).isTrue();
    }

    @Test
    void suppressedCountSaturatesInsteadOfWrapping() throws Exception {
        var bucket = new OperationalLog.Bucket(100);
        // Reach the representational limit without billions of simulated events.
        var count = OperationalLog.Bucket.class.getDeclaredField("suppressed");
        count.setAccessible(true);
        count.setLong(bucket, Long.MAX_VALUE - 1);
        assertThat(bucket.admit(101)).isEqualTo(-1);
        assertThat(bucket.admit(102)).isEqualTo(-1);
        assertThat(bucket.admit(100 + TimeUnit.SECONDS.toNanos(30))).isEqualTo(Long.MAX_VALUE);
    }
}
