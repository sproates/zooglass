package io.zooglass.runtime;

import static io.zooglass.runtime.FactFixtures.configuration;
import static io.zooglass.runtime.FactFixtures.event;
import static io.zooglass.runtime.FactFixtures.retire;
import static io.zooglass.runtime.FactFixtures.snapshot;
import static io.zooglass.runtime.FactFixtures.view;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

class FactRetirementTests {

    @TempDir Path directory;

    @ParameterizedTest
    @ValueSource(strings = {"contiguousSequence", "untracked"})
    void retirementBeforeObservationLeavesSharedInputStatusUnchangedAcrossRestart(String mode) {
        var base = configuration("sqlite", 10, false);
        var source =
                "untracked".equals(mode)
                        ? new RuntimeConfiguration.Source("match", "v1")
                        : base.sources().getFirst();
        var config =
                new RuntimeConfiguration(2, "sqlite", 10, 10, 20, List.of(source), base.views());
        String db = directory.resolve(mode + ".db").toString();
        ViewCoordinator.Snapshot before;

        try (var service = new ViewCoordinator(config, db)) {
            before = snapshot(service, "original");
            var outcome = service.retire(retire("corrected", 10));
            assertThat(outcome.changedViews()).containsExactly("corrected");
            assertThat(snapshot(service, "original")).isEqualTo(before);
            assertThat(snapshot(service, "corrected").status().inputs())
                    .isEqualTo(before.status().inputs());
        }

        try (var service = new ViewCoordinator(config, db)) {
            assertThat(snapshot(service, "original")).isEqualTo(before);
            assertThat(snapshot(service, "corrected").status().inputs())
                    .isEqualTo(before.status().inputs());
            var outcome = service.apply(event(10, 10, 1, "create", "{}"));
            assertThat(outcome.changedViews()).containsExactlyInAnyOrder("original", "corrected");
            var observed = snapshot(service, "original");
            assertThat(observed.status().inputs().get("match").state()).isEqualTo("observed");
            assertThat(observed.version()).isGreaterThan(before.version());
        }
    }

    @Test
    void watermarkMakesReservedInputObservedAndVersionsBothViews() {
        try (var service = new ViewCoordinator(configuration("memory", 10, false))) {
            service.retire(retire("corrected", 10));
            var outcome = service.advance(new ProgressControl("match", "v1", "game", 5));
            assertThat(outcome.changedViews()).containsExactlyInAnyOrder("original", "corrected");
            for (String view : List.of("original", "corrected")) {
                var snapshot = snapshot(service, view);
                assertThat(snapshot.version()).isEqualTo(outcome.version());
                assertThat(snapshot.status().inputs().get("match").state()).isEqualTo("observed");
                assertThat(snapshot.status().inputs().get("match").watermarkThrough()).isEqualTo(5);
            }
        }
    }

    @Test
    void retirementDoesNotRefreshAgeOrResetItsDeadline() {
        var clock = new ReceiptAgeTests.Clock();
        try (var service = new ViewCoordinator(configuration("memory", 10, true), "", clock)) {
            service.apply(event(1, 1, 1, "create", "{}"));
            clock.advance(4000);
            assertThat(service.retire(retire("corrected", 2)).status()).isEqualTo("applied");
            var empty = snapshot(service, "corrected");
            assertThat(empty.data().get("goals")).isEmpty();
            assertThat(empty.status().publication()).isEqualTo("ready");
            assertThat(empty.status().fields().get("goals").freshness()).isEqualTo("fresh");
            clock.advance(1000);
            assertThat(snapshot(service, "corrected").status().fields().get("goals").freshness())
                    .isEqualTo("stale");
            assertThat(service.retire(retire("corrected", 2)).status()).isEqualTo("unchanged");
            assertThat(service.retire(retire("corrected", 1)).reason())
                    .isEqualTo("backwardsFactFloor");
        }
    }

    @Test
    void floorBeforeCreateSurvivesRestartWithoutInventingFieldPresence() {
        var config = configuration("sqlite", 10, false);
        String db = directory.resolve("floor.db").toString();
        try (var service = new ViewCoordinator(config, db)) {
            assertThat(service.retire(retire("corrected", 10)).status()).isEqualTo("committed");
            assertThat(snapshot(service, "corrected").data()).isEmpty();
            assertThat(snapshot(service, "corrected").status().fields().get("goals").freshness())
                    .isEqualTo("absent");
        }
        try (var service = new ViewCoordinator(config, db)) {
            assertThat(
                            snapshot(service, "corrected")
                                    .status()
                                    .fields()
                                    .get("goals")
                                    .facts()
                                    .minimumBirthSequence())
                    .isEqualTo(10);
            assertThat(service.apply(event(1, 1, 1, "create", "{}")).targets().getLast().reason())
                    .isEqualTo("factOutsideRetention");
            assertThat(service.apply(event(10, 10, 1, "create", "{}")).status())
                    .isEqualTo("committed");
            assertThat(snapshot(service, "corrected").data().get("goals")).hasSize(1);
        }
    }

    @Test
    void invalidFieldOrBackwardsFloorRollsBackEveryNamedField() {
        var base = configuration("memory", 10, false);
        var field = base.views().getLast().fields().get("goals");
        var view = new RuntimeConfiguration.View("both", Map.of("a", field, "b", field));
        var config =
                new RuntimeConfiguration(2, "memory", 10, 10, 20, base.sources(), List.of(view));
        try (var service = new ViewCoordinator(config)) {
            service.apply(event(1, 1, 1, "create", "{}"));
            service.retire(new FactRetirement("both", "game", List.of("b"), 3));
            var before = snapshot(service, "both");
            assertThat(
                            service.retire(new FactRetirement("both", "game", List.of("a", "b"), 2))
                                    .reason())
                    .isEqualTo("backwardsFactFloor");
            assertThat(
                            service.retire(
                                            new FactRetirement(
                                                    "both", "game", List.of("a", "missing"), 3))
                                    .reason())
                    .isEqualTo("unknownFactField");
            assertThat(snapshot(service, "both")).isEqualTo(before);
            assertThat(
                            service.retire(new FactRetirement("both", "game", List.of("a", "b"), 3))
                                    .status())
                    .isEqualTo("applied");
            assertThat(snapshot(service, "both").data().get("a")).isEmpty();
        }
    }
}
