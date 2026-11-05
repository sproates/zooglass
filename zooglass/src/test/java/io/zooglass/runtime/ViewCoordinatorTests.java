package io.zooglass.runtime;

import static io.zooglass.runtime.IdentityFixtures.configuration;
import static io.zooglass.runtime.IdentityFixtures.event;
import static io.zooglass.runtime.IdentityFixtures.parse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.spy;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;

class ViewCoordinatorTests {

    @Test
    void delayedPublicationsFeedIndependentViewsAndRetriesDoNotRepeatArrival() {
        var runtime = new ViewCoordinator(configuration(10, 100, 10));
        assertThat(runtime.apply(event(40)).version()).isEqualTo(1);
        runtime.apply(event(42));
        assertThat(runtime.apply(event(41)).changedViews()).containsExactly("history", "arrival");
        assertThat(
                        runtime.snapshot("latest", "car")
                                .orElseThrow()
                                .data()
                                .get("position")
                                .path("publicationSequence")
                                .longValue())
                .isEqualTo(42);
        assertThat(runtime.snapshot("history", "car").orElseThrow().data().get("position"))
                .extracting(node -> node.path("publicationSequence").longValue())
                .containsExactly(40L, 41L, 42L);
        var before = runtime.snapshot("arrival", "car");
        assertThat(runtime.apply(event(41)).status()).isEqualTo("duplicate");
        assertThat(runtime.apply(event(41)).version()).isEqualTo(3);
        assertThat(runtime.snapshot("arrival", "car")).isEqualTo(before);
    }

    @Test
    void conflictsAndUnknownSourcesDoNotChangeState() {
        var runtime = new ViewCoordinator(configuration(10, 100, 10));
        runtime.apply(event(1));
        var before = runtime.snapshot("arrival", "car");
        assertThat(
                        runtime.apply(
                                        parse(
                                                "fleet",
                                                "trip-1",
                                                "car",
                                                1,
                                                "position",
                                                "{\"value\":2}"))
                                .reason())
                .isEqualTo("identityConflict");
        assertThat(
                        runtime.apply(parse("fleet", "trip-1", "car", 1, "other", "{\"value\":1}"))
                                .reason())
                .isEqualTo("identityConflict");
        assertThat(runtime.apply(parse("fleet", "other", "car", 2, "position", "{}")).reason())
                .isEqualTo("unknownEpoch");
        assertThat(runtime.apply(parse("unknown", "trip-1", "car", 2, "position", "{}")).reason())
                .isEqualTo("unknownSource");
        assertThat(runtime.snapshot("arrival", "car")).isEqualTo(before);
        assertThat(runtime.apply(event(2)).version()).isEqualTo(2);
    }

    @Test
    void retentionFloorNeverFallsAndUnmatchedEventsAreStillAdmitted() {
        var runtime = new ViewCoordinator(configuration(10, 3, 10));
        runtime.apply(event(40));
        runtime.apply(event(42)); // floor 40: still accepts 40 as duplicate and 41 as delayed
        assertThat(runtime.apply(event(40)).status()).isEqualTo("duplicate");
        runtime.apply(event(41));
        runtime.apply(event(43)); // floor 41
        assertThat(runtime.apply(event(40)).reason()).isEqualTo("outsideRetention");
        assertThat(runtime.apply(event(41)).status()).isEqualTo("duplicate");
        var unmatched = parse("backup", "trip-1", "car", 1, "nothing", "{}");
        assertThat(runtime.apply(unmatched).changedViews()).isEmpty();
        assertThat(runtime.apply(unmatched).status()).isEqualTo("duplicate");
        assertThat(runtime.apply(event(40)).reason()).isEqualTo("outsideRetention");
    }

    @Test
    void capacityFailureRollsBackViewsIdentityAndRetentionFloor() {
        var runtime = new ViewCoordinator(configuration(1, 3, 1));
        runtime.apply(event(1));
        var before = runtime.snapshot("latest", "car");
        assertThat(runtime.apply(event(10)).reason()).isEqualTo("historyLimit");
        assertThat(runtime.snapshot("latest", "car")).isEqualTo(before);
        assertThat(runtime.apply(event(1)).status()).isEqualTo("duplicate");
        assertThat(runtime.apply(event(10)).reason()).isEqualTo("historyLimit");
        assertThat(runtime.apply(parse("fleet", "trip-1", "other", 1, "position", "{}")).reason())
                .isEqualTo("streamLimit");
        assertThat(runtime.snapshot("latest", "other").orElseThrow().data()).isEmpty();
    }

    @Test
    void processingExceptionDoesNotConsumeIdentityAndSnapshotsOwnTheirValues() {
        var runtime = new ViewCoordinator(configuration(10, 10, 10));
        JsonNode broken = spy(event(1).payload());
        doThrow(new IllegalStateException("copy failure")).when(broken).deepCopy();
        var publication = new Publication("fleet", "trip-1", "car", 1, "position", broken);
        assertThatThrownBy(() -> runtime.apply(publication))
                .isInstanceOf(IllegalStateException.class);
        assertThat(runtime.snapshot("latest", "car").orElseThrow().data()).isEmpty();
        var valid = event(1);
        assertThat(runtime.apply(valid).status()).isEqualTo("applied");
        ((ObjectNode) valid.payload()).put("value", 99);
        var snapshot = runtime.snapshot("latest", "car").orElseThrow();
        ((ObjectNode) snapshot.data().get("position").get("payload")).put("value", 88);
        assertThat(
                        runtime.snapshot("latest", "car")
                                .orElseThrow()
                                .data()
                                .get("position")
                                .at("/payload/value")
                                .intValue())
                .isEqualTo(1);
        assertThat(runtime.apply(event(1)).status()).isEqualTo("duplicate");
    }

    @Test
    void independentSourceFieldsKeepTheirOwnSequenceOrder() {
        var defaults = configuration(10, 10, 10);
        var view =
                new RuntimeConfiguration.View(
                        "combined",
                        Map.of(
                                "primary",
                                new RuntimeConfiguration.Field(
                                        "fleet", "position", "latestBySequence"),
                                "secondary",
                                new RuntimeConfiguration.Field(
                                        "backup", "position", "latestBySequence")));
        var config =
                new RuntimeConfiguration(
                        2, "memory", 10, 10, 10, defaults.sources(), List.of(view));
        var runtime = new ViewCoordinator(config);

        runtime.apply(event(5));
        runtime.apply(parse("backup", "trip-1", "car", 1, "position", "{\"value\":99}"));
        assertThat(runtime.apply(parse("fleet", "trip-1", "car", 6, "other", "{}")).changedViews())
                .isEmpty();

        var fields = runtime.snapshot("combined", "car").orElseThrow().data();
        assertThat(fields.get("primary").at("/payload/value").intValue()).isEqualTo(5);
        assertThat(fields.get("secondary").at("/payload/value").intValue()).isEqualTo(99);

        var restarted = new ViewCoordinator(config);
        assertThat(restarted.snapshot("combined", "car").orElseThrow().data()).isEmpty();
        assertThat(restarted.apply(event(5)).status()).isEqualTo("applied");
    }

    @Test
    void concurrentRetriesApplyOnceAndEntityIdentityIsIndependent() throws Exception {
        var runtime = new ViewCoordinator(configuration(10, 10, 10));
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Callable<PublicationOutcome>> calls = new ArrayList<>();
            for (int index = 0; index < 20; index++) {
                calls.add(() -> runtime.apply(event(1)));
            }
            var outcomes = new ArrayList<PublicationOutcome>();
            for (var result : executor.invokeAll(calls)) {
                outcomes.add(result.get());
            }
            assertThat(outcomes)
                    .filteredOn(outcome -> outcome.status().equals("applied"))
                    .hasSize(1);
            assertThat(outcomes)
                    .filteredOn(outcome -> outcome.status().equals("duplicate"))
                    .hasSize(19);
        }
        assertThat(runtime.apply(parse("fleet", "trip-1", "other", 1, "position", "{}")).status())
                .isEqualTo("applied");
        assertThat(runtime.snapshot("missing", "car")).isEmpty();
        assertThat(runtime.snapshot("latest", "empty").orElseThrow().version()).isZero();
    }
}
