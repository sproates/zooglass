package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

class FreshnessSchedulingTests {
    static RuntimeConfiguration config() {
        var field =
                new RuntimeConfiguration.Field(
                        "fleet",
                        "position",
                        "arrival",
                        null,
                        null,
                        null,
                        new RuntimeConfiguration.Freshness("receiptAge", 100L));
        return new RuntimeConfiguration(
                2,
                "memory",
                20,
                20,
                20,
                List.of(new RuntimeConfiguration.Source("fleet", "v1")),
                List.of(new RuntimeConfiguration.View("fleet", Map.of("position", field))));
    }

    static final class ManualAlarms implements AlarmScheduler {
        final ReceiptAgeTests.Clock clock;
        final List<Pending> pending = new ArrayList<>();
        boolean closed;

        ManualAlarms(ReceiptAgeTests.Clock clock) {
            this.clock = clock;
        }

        final class Pending implements Task {
            final long due;
            final Runnable wake;
            boolean done;

            Pending(Runnable wake, long delay) {
                this.wake = wake;
                due = clock.elapsed + delay;
            }

            public boolean isDone() {
                return done;
            }

            public void cancel() {
                done = true;
            }
        }

        public Task schedule(Runnable wake, long delay) {
            if (closed) throw new IllegalStateException("closed");
            var task = new Pending(wake, delay);
            pending.add(task);
            return task;
        }

        void dispatchDue() {
            for (var task : List.copyOf(pending)) {
                if (!task.done && task.due <= clock.elapsed) {
                    task.done = true;
                    task.wake.run();
                }
            }
        }

        public void close() {
            closed = true;
            pending.forEach(Pending::cancel);
        }
    }

    @Test
    void alarmExpiresAtEqualityWithoutReadAndDuplicateDoesNotRefresh() {
        var clock = new ReceiptAgeTests.Clock();
        var alarms = new ManualAlarms(clock);
        var received = new ArrayList<ViewCoordinator.Snapshot>();
        try (var service = new ViewCoordinator(config(), "", clock, null, () -> alarms)) {
            service.listen(received::add);
            service.apply(ProgressTests.event(1));
            clock.advance(99);
            assertThat(service.apply(ProgressTests.event(1)).status()).isEqualTo("duplicate");
            alarms.dispatchDue();
            assertThat(received).hasSize(1);
            clock.advance(1);
            assertThat(received).hasSize(1);
            alarms.dispatchDue();
            assertThat(received).hasSize(2);
            var expired = received.getLast();
            assertThat(expired.version()).isEqualTo(2);
            assertThat(expired.status().fields().get("position").freshness()).isEqualTo("stale");
            assertThat(expired.status().fields().get("position").receivedAtMillis())
                    .isEqualTo(1_000_000);
            assertThat(alarms.pending).hasSize(1);
        }
        assertThat(alarms.closed).isTrue();
    }

    @Test
    void replacementCancelsOldDeadlineAndCloseCancelsPendingWork() {
        var clock = new ReceiptAgeTests.Clock();
        var alarms = new ManualAlarms(clock);
        var received = new ArrayList<ViewCoordinator.Snapshot>();
        try (var service = new ViewCoordinator(config(), "", clock, null, () -> alarms)) {
            service.listen(received::add);
            service.apply(ProgressTests.event(1));
            clock.advance(50);
            service.apply(ProgressTests.event(2));
            assertThat(alarms.pending.getFirst().done).isTrue();
            clock.advance(50);
            alarms.dispatchDue();
            assertThat(received).hasSize(2);
            clock.advance(50);
            alarms.dispatchDue();
            assertThat(received).hasSize(3);
            service.apply(ProgressTests.event(3));
        }
        clock.advance(100);
        alarms.dispatchDue();
        assertThat(received).hasSize(4);
        assertThat(alarms.pending).allMatch(task -> task.done);
    }

    @Test
    void simultaneousExpiryNotifiesInEntityOrder() {
        var clock = new ReceiptAgeTests.Clock();
        var alarms = new ManualAlarms(clock);
        var received = new ArrayList<ViewCoordinator.Snapshot>();
        try (var service = new ViewCoordinator(config(), "", clock, null, () -> alarms)) {
            service.apply(IdentityFixtures.parse("fleet", "v1", "zebra", 1, "position", "{}"));
            service.apply(IdentityFixtures.parse("fleet", "v1", "ant", 1, "position", "{}"));
            service.listen(received::add);
            clock.advance(100);
            alarms.dispatchDue();
            assertThat(received)
                    .extracting(ViewCoordinator.Snapshot::entityId)
                    .containsExactly("ant", "zebra");
            assertThat(received)
                    .extracting(ViewCoordinator.Snapshot::version)
                    .containsExactly(3L, 3L);
        }
    }

    @Test
    void driverIsLazyAndUsedByDynamicallyRegisteredView() {
        var clock = new ReceiptAgeTests.Clock();
        var alarms = new ManualAlarms(clock);
        var full = config();
        var empty = new RuntimeConfiguration(2, "memory", 20, 20, 20, full.sources(), List.of());
        int[] created = {0};
        try (var service =
                new ViewCoordinator(
                        empty,
                        "",
                        clock,
                        null,
                        () -> {
                            created[0]++;
                            return alarms;
                        })) {
            assertThat(created[0]).isZero();
            service.define(full.views().getFirst());
            assertThat(created[0]).isEqualTo(1);
            service.apply(ProgressTests.event(1));
            var received = new ArrayList<ViewCoordinator.Snapshot>();
            service.listen(received::add);
            clock.advance(100);
            alarms.dispatchDue();
            assertThat(received).hasSize(1);
            assertThat(received.getFirst().status().fields().get("position").freshness())
                    .isEqualTo("stale");
        }
    }

    @Test
    void recoveryArmsUsingInjectedClockAndFailedStorageClosesDriver(
            @org.junit.jupiter.api.io.TempDir java.nio.file.Path directory) {
        var clock = new ReceiptAgeTests.Clock();
        var full = config();
        var sqlite =
                new RuntimeConfiguration(2, "sqlite", 20, 20, 20, full.sources(), full.views());
        String database = directory.resolve("age.sqlite").toString();
        var first = new ManualAlarms(clock);
        try (var service = new ViewCoordinator(sqlite, database, clock, null, () -> first)) {
            service.apply(ProgressTests.event(1));
        }
        clock.advance(70);
        var resumed = new ManualAlarms(clock);
        var received = new ArrayList<ViewCoordinator.Snapshot>();
        try (var service = new ViewCoordinator(sqlite, database, clock, null, () -> resumed)) {
            service.listen(received::add);
            assertThat(resumed.pending.getFirst().due).isEqualTo(100);
            clock.advance(30);
            resumed.dispatchDue();
            assertThat(received).hasSize(1);
            assertThat(received.getFirst().status().fields().get("position").freshness())
                    .isEqualTo("stale");
        }
        var failed = new ManualAlarms(clock);
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () ->
                                new ViewCoordinator(
                                        sqlite, directory.toString(), clock, null, () -> failed))
                .isInstanceOf(RuntimeException.class);
        assertThat(failed.closed).isTrue();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void rejectedRecoveryAlarmClosesDriverAndReleasesDatabase(
            boolean failClose, @org.junit.jupiter.api.io.TempDir java.nio.file.Path directory) {
        var clock = new ReceiptAgeTests.Clock();
        var full = config();
        var sqlite =
                new RuntimeConfiguration(2, "sqlite", 20, 20, 20, full.sources(), full.views());
        String database = directory.resolve("rejected.sqlite").toString();
        try (var service =
                new ViewCoordinator(sqlite, database, clock, null, () -> new ManualAlarms(clock))) {
            service.apply(ProgressTests.event(1));
        }
        boolean[] closed = {false};
        var rejection = new java.util.concurrent.RejectedExecutionException("test rejection");
        var rejecting =
                new AlarmScheduler() {
                    public Task schedule(Runnable wake, long delay) {
                        throw rejection;
                    }

                    public void close() {
                        closed[0] = true;
                        if (failClose) throw new IllegalStateException("close failure");
                    }
                };
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> new ViewCoordinator(sqlite, database, clock, null, () -> rejecting))
                .isSameAs(rejection);
        assertThat(closed[0]).isTrue();
        assertThat(rejection.getSuppressed()).hasSize(failClose ? 1 : 0);
        try (var reopened =
                new ViewCoordinator(sqlite, database, clock, null, () -> new ManualAlarms(clock))) {
            assertThat(reopened.apply(ProgressTests.event(2)).status()).isEqualTo("committed");
        }
    }

    @Test
    void ordinaryServiceExpiresWithoutSnapshotPolling() throws InterruptedException {
        var stale = new CountDownLatch(1);
        try (var service = new ViewCoordinator(config())) {
            service.listen(
                    snapshot -> {
                        if (snapshot.status().fields().get("position").freshness().equals("stale"))
                            stale.countDown();
                    });
            service.apply(ProgressTests.event(1));
            assertThat(stale.await(5, TimeUnit.SECONDS)).isTrue();
        }
    }
}
