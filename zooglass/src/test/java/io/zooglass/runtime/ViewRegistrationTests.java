package io.zooglass.runtime;

import static io.zooglass.runtime.IdentityFixtures.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

class ViewRegistrationTests {
    @TempDir Path directory;

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void registeringTheFirstTimedFactViewActivatesBothPolicies(String storage) {
        var clock = new ReceiptAgeTests.Clock();
        var base = FactFixtures.configuration(storage, 10, false);
        var empty = new RuntimeConfiguration(2, storage, 10, 10, 20, base.sources(), List.of());
        try (var runtime =
                new ViewCoordinator(empty, directory.resolve("timed.db").toString(), clock)) {
            assertThat(runtime.define(FactFixtures.view("timed", "latestFactRevision", 10, true)))
                    .isTrue();
            assertThat(
                            runtime.apply(FactFixtures.event(1, 1, 1, "create", "{\"points\":1}"))
                                    .status())
                    .isEqualTo("applied");
            var current = runtime.snapshot("timed", "game").orElseThrow();
            assertThat(current.data().get("goals")).hasSize(1);
            assertThat(current.status().fields().get("goals").freshness()).isEqualTo("fresh");
            clock.advance(5000);
            assertThat(
                            runtime.snapshot("timed", "game")
                                    .orElseThrow()
                                    .status()
                                    .fields()
                                    .get("goals")
                                    .freshness())
                    .isEqualTo("stale");
        }
    }

    @Test
    void failedSqliteCommitDoesNotPublishAViewUpdate() throws Exception {
        var file = directory.resolve("failure.db");
        var config = SqliteRecoveryTests.configuration();
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            runtime.apply(event(1));
        }
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file);
                var statement = connection.createStatement()) {
            statement.execute(
                    "CREATE TRIGGER refuse_view BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,"
                            + " 'fixture failure'); END");
        }
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            var changes = new ArrayList<ViewCoordinator.Snapshot>();
            runtime.listen(changes::add);
            assertThatThrownBy(() -> runtime.apply(event(2)))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(changes).isEmpty();
        }
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            assertThat(runtime.apply(event(1)).status()).isEqualTo("duplicate");
        }
    }

    @Test
    void registrationIsValidatedDoesNotBackfillAndOnlyAffectsFuturePublications() {
        var config = IdentityFixtures.configuration(10, 100, 100);
        try (var runtime = new ViewCoordinator(config)) {
            runtime.apply(event(1));
            var snapshots = new ArrayList<ViewCoordinator.Snapshot>();
            var detach = runtime.listen(snapshots::add);
            var added = IdentityFixtures.view("added", "latestBySequence");
            assertThat(runtime.define(added)).isTrue();
            assertThat(runtime.define(added)).isFalse();
            assertThat(runtime.snapshot("added", "car").orElseThrow().data()).isEmpty();
            assertThat(snapshots).isEmpty();
            assertThatThrownBy(
                            () ->
                                    runtime.define(
                                            new RuntimeConfiguration.View(
                                                    "invalid",
                                                    Map.of(
                                                            "position",
                                                            new RuntimeConfiguration.Field(
                                                                    "unknown",
                                                                    "position",
                                                                    "arrival")))))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThat(runtime.containsView("invalid")).isFalse();
            assertThat(runtime.apply(event(1)).status()).isEqualTo("duplicate");
            assertThat(runtime.snapshot("added", "car").orElseThrow().data()).isEmpty();
            runtime.apply(event(2));
            assertThat(snapshots).extracting(ViewCoordinator.Snapshot::viewId).contains("added");
            assertThat(
                            runtime.snapshot("added", "car")
                                    .orElseThrow()
                                    .data()
                                    .get("position")
                                    .path("publicationSequence")
                                    .longValue())
                    .isEqualTo(2);
            detach.run();
        }
    }

    @Test
    void sqliteRegistrationAndSubsequentStateRecoverWithTheExpandedConfiguration() {
        var initial = SqliteRecoveryTests.configuration();
        var added = IdentityFixtures.view("added", "latestBySequence");
        var definitions = new ArrayList<>(initial.views());
        definitions.add(added);
        var expanded =
                new RuntimeConfiguration(
                        initial.contractVersion(),
                        initial.storage(),
                        initial.maxStreams(),
                        initial.identityWindow(),
                        initial.maxHistoryEntries(),
                        initial.sources(),
                        List.copyOf(definitions));
        var database = directory.resolve("registered.sqlite").toString();
        try (var runtime = new ViewCoordinator(initial, database)) {
            runtime.apply(event(1));
            assertThat(runtime.define(added)).isTrue();
            runtime.apply(event(2));
        }
        assertThatThrownBy(() -> new ViewCoordinator(initial, database))
                .isInstanceOf(IllegalStateException.class);
        try (var recovered = new ViewCoordinator(expanded, database)) {
            assertThat(
                            recovered
                                    .snapshot("added", "car")
                                    .orElseThrow()
                                    .data()
                                    .get("position")
                                    .path("publicationSequence")
                                    .longValue())
                    .isEqualTo(2);
            assertThat(recovered.apply(event(2)).status()).isEqualTo("duplicate");
        }
    }

    @Test
    void listenerFailureCannotChangeCommittedOutcomeAndMetadataChangesArePublished() {
        var clock = new ReceiptAgeTests.Clock();
        try (var runtime = new ViewCoordinator(ReceiptAgeTests.config("memory", 5000), "", clock)) {
            var snapshots = new ArrayList<ViewCoordinator.Snapshot>();
            runtime.listen(
                    snapshot -> {
                        throw new IllegalStateException("delivery fixture failed");
                    });
            runtime.listen(snapshots::add);
            assertThat(runtime.apply(ProgressTests.event(1)).status()).isEqualTo("applied");
            assertThat(snapshots.getLast().status().fields().get("position").freshness())
                    .isEqualTo("fresh");
            runtime.advance(ProgressTests.watermark(2));
            assertThat(snapshots.getLast().status().inputs().get("fleet").watermarkThrough())
                    .isEqualTo(2);
            clock.advance(5000);
            runtime.snapshot("fleet", "car");
            assertThat(snapshots.getLast().status().fields().get("position").freshness())
                    .isEqualTo("stale");
        }
    }
}
