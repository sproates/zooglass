package io.zooglass.runtime;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PostgresOwnershipIT {
    private final HaStaticProfile profile = HaStaticProfileTests.profile(HaStaticProfileTests.config());
    private PostgresTestDatabase db;
    private static final Duration LEASE = Duration.ofSeconds(30);

    @BeforeEach
    void createSchema() throws Exception { db = new PostgresTestDatabase(); }

    @AfterEach
    void dropSchema() throws Exception { if (db != null) db.close(); }

    private OwnedRuntime acquire() {
        return ViewCoordinator.postgres(profile, db::open, LEASE);
    }

    private static OwnedRuntime activate(OwnedRuntime owner) {
        owner.recover();
        owner.activate();
        return owner;
    }

    private static Publication input(long sequence) {
        return new Publication("backup", "v1", "car", sequence, "score", StateRowJson.JSON.readTree("{\"v\":1}"));
    }

    private static OwnedRuntime.Admission handoff(OwnedRuntime owner, OwnedRuntime.Content content) {
        var delivered = new AtomicReference<OwnedRuntime.Admission>();
        owner.handoff(content, delivered::set);
        return delivered.get();
    }

    private String value(String column) throws SQLException {
        try (var connection = db.open(); var statement = connection.createStatement();
                var row = statement.executeQuery("SELECT " + column + " FROM zooglass_runtime")) {
            assertThat(row.next()).isTrue();
            return row.getString(1);
        }
    }

    @Test
    void simultaneousAcquisitionHasOnlyOneWinnerAndRecoveryPrecedesActivation() throws Exception {
        var start = new CountDownLatch(1);
        var first = CompletableFuture.supplyAsync(() -> compete(start));
        var second = CompletableFuture.supplyAsync(() -> compete(start));
        start.countDown();
        var a = first.get(8, TimeUnit.SECONDS);
        var b = second.get(8, TimeUnit.SECONDS);
        assertThat((a == null) != (b == null)).isTrue();
        try (var winner = a == null ? b : a) {
            assertThat(value("generation")).isEqualTo("1");
            assertThat(value("role")).isEqualTo("recovering");
            assertThat(winner.servingReady()).isFalse();
            assertThatThrownBy(winner::activate).isInstanceOf(IllegalStateException.class);
            winner.recover();
            winner.renew();
            assertThatThrownBy(() -> winner.publish(input(1))).isInstanceOf(StorageUnavailable.class);
            winner.activate();
            assertThat(value("role")).isEqualTo("active");
            assertThat(winner.servingReady()).isTrue();
        }
    }

    private OwnedRuntime compete(CountDownLatch start) {
        await(start);
        try {
            return acquire();
        } catch (StorageUnavailable refused) {
            return null;
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"renew", "activate", "mutate", "duplicate", "snapshot", "handoff"})
    void takeoverRejectsEachOldEntryPointAndPreservesOnlyOriginallyAdmittedData(String operation) throws Exception {
        try (var old = acquire()) {
            old.recover();
            boolean recovering = operation.equals("activate");
            OwnedRuntime.Content queued = null;
            if (!recovering) {
                old.activate();
                queued = old.publish(input(1)).receipt();
            }
            var captured = queued;
            String oldAttempt = value("attempt");
            UUID incarnation = UUID.fromString(value("incarnation"));
            db.expireLease();
            try (var next = activate(acquire())) {
                assertThat(value("attempt")).isNotEqualTo(oldAttempt);
                var current = handoff(next, next.snapshot("trail", "car"));
                assertThat(current.incarnation()).isEqualTo(incarnation);
                assertThat(current.generation()).isEqualTo("2");
                assertThatThrownBy(() -> {
                    switch (operation) {
                        case "renew" -> old.renew();
                        case "activate" -> old.activate();
                        case "mutate" -> old.publish(input(2));
                        case "duplicate" -> old.publish(input(1));
                        case "snapshot" -> old.snapshot("trail", "car");
                        case "handoff" -> handoff(old, captured);
                        default -> throw new AssertionError(operation);
                    }
                }).isInstanceOf(StorageUnavailable.class);
                assertThat(old.servingReady()).isFalse();
                if (captured != null) {
                    assertThatThrownBy(() -> handoff(next, captured)).isInstanceOf(IllegalStateException.class);
                    var retry = StateRowJson.JSON.readTree(handoff(next, next.publish(input(1)).receipt()).body());
                    assertThat(retry.path("reason").asText()).isEqualTo("alreadyCommitted");
                    assertThat(retry.path("version").longValue()).isEqualTo(1);
                }
                assertThat(next.servingReady()).isTrue();
            }
        }
    }

    @Test
    void expiryAlonePreventsRenewalAndGenerationExhaustionFailsClosed() throws Exception {
        try (var owner = activate(acquire())) {
            db.expireLease();
            assertThatThrownBy(owner::renew).isInstanceOf(StorageUnavailable.class);
        }
        db.execute("UPDATE zooglass_runtime SET generation=9007199254740992");
        try (var owner = activate(acquire())) {
            assertThat(handoff(owner, owner.snapshot("trail", "car")).generation()).isEqualTo("9007199254740993");
        }
        db.execute("UPDATE zooglass_runtime SET generation=9223372036854775807");
        assertThatThrownBy(this::acquire).isInstanceOf(StorageUnavailable.class);
        assertThat(value("generation")).isEqualTo(Long.toString(Long.MAX_VALUE));
        assertThat(value("attempt")).isNull();
    }

    @Test
    void queuedContentAndNewSnapshotRetainTheirOwnRevisionsAndOriginalCommitMetadata() {
        try (var owner = activate(acquire())) {
            var first = owner.publish(input(1));
            var frame = first.updates().getLast();
            var noMatch = new Publication("backup", "v1", "car", 2, "other", StateRowJson.JSON.readTree("{}"));
            owner.publish(noMatch);
            var admitted = handoff(owner, frame);
            assertThat(admitted.contentRevision()).isEqualTo("1");
            assertThat(admitted.authorityRevision()).isEqualTo("2");
            assertThat(StateRowJson.JSON.readTree(admitted.body()).path("version").longValue()).isEqualTo(1);
            var snapshot = handoff(owner, owner.snapshot("trail", "car"));
            assertThat(snapshot.contentRevision()).isEqualTo("2");
            assertThat(StateRowJson.JSON.readTree(snapshot.body()).path("version").longValue()).isEqualTo(1);
            var duplicate = handoff(owner, owner.publish(input(1)).receipt());
            assertThat(duplicate.contentRevision()).isEqualTo("2");
            assertThat(StateRowJson.JSON.readTree(duplicate.body()).path("version").longValue()).isEqualTo(1);
        }
    }

    @Test
    void cacheMismatchPreventsNewCaptureAndPoisonsAttempt() throws SQLException {
        try (var owner = activate(acquire())) {
            var queued = owner.snapshot("trail", "car");
            db.execute("UPDATE zooglass_runtime SET revision=1");
            assertThatThrownBy(() -> owner.snapshot("trail", "car")).isInstanceOf(StorageUnavailable.class);
            assertThatThrownBy(() -> handoff(owner, queued)).isInstanceOf(StorageUnavailable.class);
            assertThat(owner.servingReady()).isFalse();
        }
    }

    @Test
    void handoffConsumesExactlyOnceAndBlockedRecipientHoldsNoOwnerOrDatabaseLock() throws Exception {
        try (var owner = activate(acquire())) {
            var content = owner.snapshot("trail", "car");
            var entered = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var calls = new AtomicInteger();
            var first = CompletableFuture.runAsync(() -> owner.handoff(content, admitted -> {
                entered.countDown();
                await(release);
                calls.incrementAndGet();
                throw new IllegalArgumentException("recipient stopped");
            }));
            try {
                assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> owner.handoff(content, ignored -> calls.incrementAndGet()))
                        .isInstanceOf(IllegalStateException.class);
                owner.renew();
                db.expireLease();
                try (var successor = activate(acquire())) {
                    assertThat(successor.servingReady()).isTrue();
                }
            } finally {
                release.countDown();
            }
            assertThatThrownBy(() -> first.get(3, TimeUnit.SECONDS)).hasCauseInstanceOf(IllegalArgumentException.class);
            assertThat(calls).hasValue(1);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"acquire", "recover", "activate", "renew", "capture", "admit"})
    void uncertainCommitNeverProducesNewContentOrReusableAuthority(String operation) throws Exception {
        var armed = new AtomicBoolean(operation.equals("acquire"));
        PostgresState.Connections connections = () -> db.interruptCommit(armed, true);
        if (operation.equals("acquire")) {
            assertThatThrownBy(() -> ViewCoordinator.postgres(profile, connections, LEASE))
                    .isInstanceOf(StorageUnavailable.class);
        } else {
            try (var owner = ViewCoordinator.postgres(profile, connections, LEASE)) {
                if (!operation.equals("recover")) owner.recover();
                if (!List.of("recover", "activate").contains(operation)) owner.activate();
                var content = operation.equals("admit") ? owner.snapshot("trail", "car") : null;
                armed.set(true);
                assertThatThrownBy(() -> {
                    switch (operation) {
                        case "recover" -> owner.recover();
                        case "activate" -> owner.activate();
                        case "renew" -> owner.renew();
                        case "capture" -> owner.snapshot("trail", "car");
                        case "admit" -> owner.handoff(content, ignored -> { throw new AssertionError("unconfirmed handoff"); });
                        default -> throw new AssertionError(operation);
                    }
                }).isInstanceOf(StorageUnavailable.class);
                assertThatThrownBy(owner::renew).isInstanceOf(StorageUnavailable.class);
            }
        }
        assertThatThrownBy(this::acquire).isInstanceOf(StorageUnavailable.class);
        db.expireLease();
        try (var recovered = activate(acquire())) {
            assertThat(handoff(recovered, recovered.snapshot("trail", "car")).generation()).isEqualTo("2");
        }
    }

    @Test
    void renewalSamplesDatabaseTimeAfterItsRowLockWait() throws Exception {
        try (var connection = db.open(); var locker = db.open()) {
            int waiter = backendPid(connection);
            try (var owner = activate(ViewCoordinator.postgres(profile, () -> connection, LEASE))) {
                locker.setAutoCommit(false);
                try (var lock = locker.createStatement()) {
                    lock.execute("SELECT singleton FROM zooglass_runtime FOR UPDATE");
                    var renewing = CompletableFuture.runAsync(owner::renew);
                    try {
                        long limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                        boolean blocked = false;
                        while (!blocked && System.nanoTime() < limit) {
                            try (var row = lock.executeQuery("SELECT pg_backend_pid() = ANY(pg_blocking_pids(" + waiter + "))")) {
                                row.next();
                                blocked = row.getBoolean(1);
                            }
                        }
                        assertThat(blocked).as("renewal waiting on this row lock").isTrue();
                        // The deadline follows the waiter's transaction start and precedes lock release.
                        lock.execute("UPDATE zooglass_runtime SET lease_until=clock_timestamp()");
                        locker.commit();
                    } finally {
                        locker.rollback();
                    }
                    assertThatThrownBy(() -> renewing.get(5, TimeUnit.SECONDS)).hasCauseInstanceOf(StorageUnavailable.class);
                }
            }
        }
    }

    @Test
    void boundedLockWaitPoisonsBlockedOwnerWithoutCommitting() throws Exception {
        try (var owner = activate(acquire()); var holder = db.open(); var sql = holder.createStatement()) {
            holder.setAutoCommit(false);
            sql.execute("SELECT singleton FROM zooglass_runtime FOR UPDATE");
            long started = System.nanoTime();
            try {
                assertThatThrownBy(() -> owner.publish(input(1))).isInstanceOf(StorageUnavailable.class)
                        .rootCause().isInstanceOfSatisfying(SQLException.class,
                                failure -> assertThat(failure.getSQLState()).isEqualTo("55P03"));
                assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(8));
            } finally {
                holder.rollback();
            }
            assertThat(owner.servingReady()).isFalse();
            assertThat(value("revision")).isEqualTo("0");
        }
    }

    @Test
    void pausedTransactionIsTerminatedByServerAndItsLockIsReleased() throws Exception {
        try (var paused = db.open(); var owner = activate(ViewCoordinator.postgres(profile, () -> paused, LEASE))) {
            // Leave the owned connection idle in a transaction holding the real authority row lock.
            try (var sql = paused.createStatement()) {
                sql.execute("SELECT singleton FROM zooglass_runtime FOR UPDATE");
            }
            try (var waiter = db.open(); var sql = waiter.createStatement()) {
                sql.execute("SET statement_timeout='20s'");
                long started = System.nanoTime();
                sql.execute("SELECT singleton FROM zooglass_runtime FOR UPDATE");
                assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(20));
            }
            assertThat(owner.servingReady()).isFalse();
        }
    }

    @Test
    void localFailureAfterBackendCommitPoisonsCacheBeforeAnyReceiptOrUpdateEscapes() throws Exception {
        var armed = new AtomicBoolean();
        try (var owner = activate(ViewCoordinator.postgres(profile, () -> db.interruptCommit(armed, true,
                new IllegalStateException("Injected failure before local installation")), LEASE))) {
            var earlier = owner.snapshot("trail", "car");
            armed.set(true);
            assertThatThrownBy(() -> owner.publish(input(1))).isInstanceOf(StorageUnavailable.class);
            assertThatThrownBy(() -> handoff(owner, earlier)).isInstanceOf(StorageUnavailable.class);
            assertThat(value("revision")).isEqualTo("1");
        }
        db.expireLease();
        try (var recovered = activate(acquire())) {
            var receipt = handoff(recovered, recovered.publish(input(1)).receipt());
            assertThat(StateRowJson.JSON.readTree(receipt.body()).path("reason").asText()).isEqualTo("alreadyCommitted");
        }
    }

    private static int backendPid(Connection connection) throws SQLException {
        try (var sql = connection.createStatement(); var row = sql.executeQuery("SELECT pg_backend_pid()")) {
            row.next();
            return row.getInt(1);
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(8, TimeUnit.SECONDS)) throw new AssertionError("Test barrier timed out");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new AssertionError(interrupted);
        }
    }
}
