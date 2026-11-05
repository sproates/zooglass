package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.ArrayList;
import static io.zooglass.v2.FactFixtures.*;
import static org.assertj.core.api.Assertions.*;

class FactRecoveryTests {
    @TempDir Path directory;

    @Test
    void restartRetainsTombstonesFloorsRetriesAndReceiptAge() {
        var config = configuration("sqlite", 10, true);
        var clock = new ReceiptAgeTests.Clock();
        String db = directory.resolve("facts.db").toString();
        var withdrawn = event(3, 1, 2, "retract", "{}");
        try (var service = new ViewCoordinator(config, db, clock)) {
            service.apply(event(1, 1, 1, "create", "{}"));
            service.apply(event(2, 2, 1, "create", "{}"));
            service.apply(withdrawn);
            service.retire(retire("original", 2));
        }
        clock.advance(5000);
        try (var service = new ViewCoordinator(config, db, clock)) {
            assertThat(snapshot(service, "corrected").data().get("goals")).hasSize(1);
            assertThat(snapshot(service, "corrected").status().fields().get("goals").facts().retainedCount()).isEqualTo(2);
            assertThat(snapshot(service, "corrected").status().fields().get("goals").freshness()).isEqualTo("stale");
            assertThat(snapshot(service, "original").status().fields().get("goals").facts().minimumBirthSequence()).isEqualTo(2);
            assertThat(service.apply(withdrawn).status()).isEqualTo("duplicate");
            assertThat(service.apply(event(4, 1, 3, "revise", "{}")).targets().getLast().status()).isEqualTo("accepted");
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "json_set(state,'$.facts.goals.records.\"1\".revision',0)",
            "json_set(state,'$.facts.goals.floor',0)",
            "json_set(state,'$.facts.goals.present',json('false'))",
            "json_set(state,'$.facts.goals.type','wrong')",
            "json_set(state,'$.facts.goals.provenance.epoch','wrong')",
            "json_set(state,'$.data.goals',json('[]'),'$.candidates.goals.match.value',json('[]'))"
    })
    void corruptedProjectionOrFactRecordPreventsReadiness(String mutation) throws Exception {
        var config = configuration("sqlite", 10, false);
        Path db = directory.resolve("corrupt.db");
        try (var service = new ViewCoordinator(config, db.toString())) {
            service.apply(event(1, 1, 1, "create", "{}"));
        }
        ProgressFailureTests.execute(db, "UPDATE views SET state=" + mutation + " WHERE view='corrected'");
        assertThatThrownBy(() -> new ViewCoordinator(config, db.toString())).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void observedStreamCannotRecoverAsAnUnobservedReservation() throws Exception {
        var config = configuration("sqlite", 10, false);
        Path db = directory.resolve("reservation.db");
        try (var service = new ViewCoordinator(config, db.toString())) {
            service.apply(event(1, 1, 1, "create", "{}"));
        }
        ProgressFailureTests.execute(db, "UPDATE streams SET state=json_set(state,'$.reservationOnly',json('true'))");
        assertThatThrownBy(() -> new ViewCoordinator(config, db.toString())).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void addingFactViewsMigratesWithoutBackfillAndFailureRollsBackUpgrade() throws Exception {
        var original = ProgressTests.configuration("sqlite");
        Path db = directory.resolve("migration.db");
        try (var service = new ViewCoordinator(original, db.toString())) { service.apply(ProgressTests.event(40)); }
        var factConfig = configuration("sqlite", 10, false);
        var sources = new ArrayList<>(original.sources());
        sources.addAll(factConfig.sources());
        var views = new ArrayList<>(original.views());
        views.addAll(factConfig.views());
        var upgraded = new V2Configuration(2, "sqlite", original.maxStreams(), original.identityWindow(),
                original.maxHistoryEntries(), sources, views);
        ProgressFailureTests.execute(db, "CREATE TRIGGER refuse BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'stop'); END");
        assertThatThrownBy(() -> new ViewCoordinator(upgraded, db.toString())).isInstanceOf(IllegalStateException.class);
        try (var service = new ViewCoordinator(original, db.toString())) {
            assertThat(service.apply(ProgressTests.event(40)).status()).isEqualTo("duplicate");
        }
        ProgressFailureTests.execute(db, "DROP TRIGGER refuse");
        try (var service = new ViewCoordinator(upgraded, db.toString())) {
            assertThat(snapshot(service, "corrected").data()).isEmpty();
            assertThat(service.apply(event(1, 1, 1, "create", "{}")).status()).isEqualTo("committed");
        }
        assertThatThrownBy(() -> new ViewCoordinator(original, db.toString())).isInstanceOf(IllegalStateException.class);
    }
}
