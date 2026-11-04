package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;

import static io.zooglass.v2.ReceiptAgeTests.*;
import static org.assertj.core.api.Assertions.*;

class ReceiptAgeRecoveryTests {
    @TempDir Path directory;

    @Test
    void addingATimedViewUpgradesSchemaFourWithoutBackfillingValues() throws Exception {
        var previous = ProgressTests.configuration("sqlite");
        var db = directory.resolve("migrate.db");
        var clock = new Clock();
        try (var service = new ViewCoordinator(previous, db.toString(), clock)) {
            service.apply(ProgressTests.event(40));
        }
        var upgraded = addTimedView(previous);
        ProgressFailureTests.execute(db, "CREATE TRIGGER block_clock BEFORE UPDATE OF last_wall ON runtime BEGIN SELECT RAISE(ABORT,'clock write failed'); END");
        assertThatThrownBy(() -> new ViewCoordinator(upgraded, db.toString(), clock)).isInstanceOf(IllegalStateException.class);
        try (var original = new ViewCoordinator(previous, db.toString(), clock)) {
            assertThat(original.apply(ProgressTests.event(40)).status()).isEqualTo("duplicate");
        }
        ProgressFailureTests.execute(db, "DROP TRIGGER block_clock");

        try (var service = new ViewCoordinator(upgraded, db.toString(), clock)) {
            assertThat(service.apply(ProgressTests.event(40)).status()).isEqualTo("duplicate");
            assertThat(position(service).freshness()).isEqualTo("absent");
            assertThat(service.snapshot("mixed", "car").orElseThrow().status().fields().get("latest").freshness())
                    .isEqualTo("unspecified");
            service.apply(ProgressTests.event(41));
        }
        try (var service = new ViewCoordinator(upgraded, db.toString(), clock)) {
            assertThat(position(service).receivedAtMillis()).isEqualTo(clock.wall);
        }
        assertThatThrownBy(() -> new ViewCoordinator(previous, db.toString(), clock)).isInstanceOf(IllegalStateException.class);
    }

    private V2Configuration addTimedView(V2Configuration previous) {
        var views = new java.util.ArrayList<>(previous.views());
        views.add(config("sqlite", 5000).views().getFirst());
        return new V2Configuration(2, "sqlite", previous.maxStreams(), previous.identityWindow(),
                previous.maxHistoryEntries(), previous.sources(), views);
    }

    @Test
    void observedClockRollbackRemainsUncertainWhenWallTimeCatchesUpDuringDowntime() {
        var clock = new Clock();
        var config = config("sqlite", 10000);
        var db = directory.resolve("clock.db").toString();
        try (var service = new ViewCoordinator(config, db, clock)) {
            service.apply(ProgressTests.event(1));
            clock.advance(8000);
            service.advance(ProgressTests.watermark(1));
            clock.advance(1000);
            clock.wall -= 8000;
            service.advance(ProgressTests.watermark(2));
            assertThat(position(service).freshness()).isEqualTo("fresh");
        }
        clock.advance(8000);
        try (var service = new ViewCoordinator(config, db, clock)) {
            assertThat(position(service).freshness()).isEqualTo("ageUnknown");
            assertThat(service.apply(ProgressTests.event(1)).status()).isEqualTo("duplicate");
            service.apply(ProgressTests.event(3));
            assertThat(position(service).freshness()).isEqualTo("fresh");
        }
    }

    @Test
    void rollbackBetweenCommitsCanBeMaskedByForwardWallTime() {
        var clock = new Clock();
        var config = config("sqlite", 10_000);
        String db = directory.resolve("masked-step.db").toString();
        try (var service = new ViewCoordinator(config, db, clock)) {
            service.apply(ProgressTests.event(1));
            clock.advance(9_000);
            clock.wall -= 8_000; // Net wall advance is one second, despite nine seconds elapsed.
            service.advance(ProgressTests.watermark(1));
            assertThat(position(service).freshness()).isEqualTo("fresh");
        }
        clock.advance(8_000);
        try (var service = new ViewCoordinator(config, db, clock)) {
            assertThat(position(service).freshness()).isEqualTo("ageUnknown");
            assertThat(service.apply(ProgressTests.event(1)).status()).isEqualTo("duplicate");
            assertThat(position(service).freshness()).isEqualTo("ageUnknown");
        }
    }

    @Test
    void aReportAcceptedOnTheBackwardsStepGetsItsOwnReceiptTime() {
        var clock = new Clock();
        var config = config("sqlite", 10000);
        var db = directory.resolve("replacement.db").toString();
        try (var service = new ViewCoordinator(config, db, clock)) {
            service.apply(ProgressTests.event(1));
            clock.advance(8000);
            service.advance(ProgressTests.watermark(1));
            clock.wall -= 3000;
            service.apply(ProgressTests.event(2));
        }
        clock.advance(4000);
        try (var service = new ViewCoordinator(config, db, clock)) {
            assertThat(position(service).freshness()).isEqualTo("fresh");
            clock.advance(6000);
            assertThat(position(service).freshness()).isEqualTo("stale");
        }
    }

    @Test
    void corruptClassificationOrClockStopsStartup() throws Exception {
        var config = config("sqlite", 5000);
        var db = directory.resolve("corrupt.db");
        var clock = new Clock();
        try (var service = new ViewCoordinator(config, db.toString(), clock)) {
            service.apply(ProgressTests.event(1));
        }
        ProgressFailureTests.execute(db, "UPDATE runtime SET last_wall='bad'");
        assertThatThrownBy(() -> new ViewCoordinator(config, db.toString(), clock)).isInstanceOf(IllegalStateException.class);
        ProgressFailureTests.execute(db, "UPDATE runtime SET last_wall=1000000");
        ProgressFailureTests.execute(db, "UPDATE views SET state=json_set(state,'$.candidates.position.fleet.age.classification','invalid')");
        assertThatThrownBy(() -> new ViewCoordinator(config, db.toString(), clock)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void missingHistoricalTimestampsAreNeverInferredFromSequenceNumbers() throws Exception {
        var config = config("sqlite", 5000);
        var db = directory.resolve("state.db");
        var clock = new Clock();
        try (var service = new ViewCoordinator(config, db.toString(), clock)) {
            service.apply(ProgressTests.event(1));
        }
        ProgressFailureTests.execute(db, "UPDATE views SET state=json_remove(state,'$.candidates.position.fleet.age')");
        try (var service = new ViewCoordinator(config, db.toString(), clock)) {
            assertThat(position(service).freshness()).isEqualTo("ageUnknown");
            assertThat(position(service).receivedAtMillis()).isNull();
        }
    }

    @Test
    void failedExpiryCommitRequiresRecoveryAndDoesNotConsumeADataReceipt() throws Exception {
        var config = config("sqlite", 5000);
        var db = directory.resolve("state.db");
        var clock = new Clock();
        try (var service = new ViewCoordinator(config, db.toString(), clock)) {
            service.apply(ProgressTests.event(1));
        }
        ProgressFailureTests.execute(db, "CREATE TRIGGER refuse BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'stop'); END");
        try (var service = new ViewCoordinator(config, db.toString(), clock)) {
            clock.advance(5000);
            assertThatThrownBy(() -> snapshot(service)).isInstanceOf(IllegalStateException.class);
            assertThat(service.healthy()).isFalse();
        }
        ProgressFailureTests.execute(db, "DROP TRIGGER refuse");
        try (var service = new ViewCoordinator(config, db.toString(), clock)) {
            var recovered = snapshot(service);
            assertThat(recovered.version()).isEqualTo(2);
            assertThat(position(service).freshness()).isEqualTo("stale");
            assertThat(service.apply(ProgressTests.event(1)).version()).isEqualTo(1);
        }
    }
}
