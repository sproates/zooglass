package io.zooglass.runtime;

import static io.zooglass.runtime.IdentityFixtures.event;
import static io.zooglass.runtime.IdentityFixtures.parse;
import static io.zooglass.strategy.update.FieldUpdate.Reason.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

class PublicationExplanationTests {
    @TempDir Path directory;

    private RuntimeConfiguration configuration(String storage, int history) {
        return new RuntimeConfiguration(
                2,
                storage,
                10,
                100,
                history,
                List.of(new RuntimeConfiguration.Source("fleet", "trip-1")),
                List.of(
                        new RuntimeConfiguration.View(
                                "mixed",
                                Map.of(
                                        "arrival",
                                                new RuntimeConfiguration.Field(
                                                        "fleet", "position", "arrival"),
                                        "latest",
                                                new RuntimeConfiguration.Field(
                                                        "fleet", "position", "latestBySequence"),
                                        "history",
                                                new RuntimeConfiguration.Field(
                                                        "fleet", "position", "historyBySequence"))),
                        new RuntimeConfiguration.View(
                                "alias",
                                Map.of(
                                        "alias",
                                        new RuntimeConfiguration.Field(
                                                "fleet", "position", "latestBySequence")))));
    }

    @Test
    void reasonsComeFromTheSameProcessingAndPublicProjectionAsOrdinaryRuns() {
        for (String storage : List.of("memory", "sqlite")) {
            var config = configuration(storage, 10);
            try (var ordinary =
                            new ViewCoordinator(
                                    config,
                                    directory.resolve(storage + "-ordinary.db").toString());
                    var explained =
                            new ViewCoordinator(
                                    config,
                                    directory.resolve(storage + "-explained.db").toString())) {
                var normalFrames = new ArrayList<ViewCoordinator.Snapshot>();
                var explainedFrames = new ArrayList<ViewCoordinator.Snapshot>();
                ordinary.listen(normalFrames::add);
                explained.listen(explainedFrames::add);
                for (long sequence : List.of(40L, 42L, 41L, 41L)) {
                    var expected = ordinary.apply(event(sequence));
                    var result = explained.applyExplained(event(sequence));
                    assertThat(result.outcome()).isEqualTo(expected);
                    assertThat(new JsonMapper().writeValueAsString(result.outcome()))
                            .isEqualTo(new JsonMapper().writeValueAsString(expected));
                    assertThat(
                                    ((StateStore)
                                                    ReflectionTestUtils.getField(
                                                            explained, "storage"))
                                            .current())
                            .isEqualTo(
                                    ((StateStore) ReflectionTestUtils.getField(ordinary, "storage"))
                                            .current());
                    assertThat(explained.snapshot("mixed", "car"))
                            .isEqualTo(ordinary.snapshot("mixed", "car"));
                    assertThat(explained.snapshot("alias", "car"))
                            .isEqualTo(ordinary.snapshot("alias", "car"));
                }
                assertThat(explainedFrames).isEqualTo(normalFrames);
                var result = explained.applyExplained(event(39));
                assertThat(result.decision().format()).isEqualTo("publication-decision/v1");
                assertThat(result.decision().installed()).isTrue();
                assertThat(result.decision().targets())
                        .extracting(PublicationDecision.Target::viewId)
                        .containsExactly("mixed", "alias");
                assertThat(result.decision().targets().getFirst().fields())
                        .containsExactly(
                                new PublicationDecision.Field(
                                        "arrival", "arrival", ARRIVAL_REPLACED, true, true),
                                new PublicationDecision.Field(
                                        "history",
                                        "historyBySequence",
                                        HISTORY_INSERTED,
                                        true,
                                        true),
                                new PublicationDecision.Field(
                                        "latest", "latestBySequence", LATEST_OLDER, false, false));
                assertThat(result.decision().targets().getLast().fields())
                        .containsExactly(
                                new PublicationDecision.Field(
                                        "alias", "latestBySequence", LATEST_OLDER, false, false));
                assertThatThrownBy(() -> result.decision().targets().clear())
                        .isInstanceOf(UnsupportedOperationException.class);
                assertThatThrownBy(() -> result.decision().targets().getFirst().fields().clear())
                        .isInstanceOf(UnsupportedOperationException.class);
            }
        }
    }

    @Test
    void inputAliasesShareTheSameRetainedCandidate() {
        var inputs =
                List.of(
                        new RuntimeConfiguration.Input("fleet", "position"),
                        new RuntimeConfiguration.Input("fleet", "correction"));
        var config =
                new RuntimeConfiguration(
                        2,
                        "memory",
                        10,
                        100,
                        10,
                        List.of(new RuntimeConfiguration.Source("fleet", "trip-1")),
                        List.of(
                                new RuntimeConfiguration.View(
                                        "aliases",
                                        Map.of(
                                                "latest",
                                                        new RuntimeConfiguration.Field(
                                                                null,
                                                                null,
                                                                "latestBySequence",
                                                                inputs,
                                                                null),
                                                "history",
                                                        new RuntimeConfiguration.Field(
                                                                null,
                                                                null,
                                                                "historyBySequence",
                                                                inputs,
                                                                null)))));
        try (var runtime = new ViewCoordinator(config)) {
            runtime.applyExplained(event(42));
            var result =
                    runtime.applyExplained(
                            parse("fleet", "trip-1", "car", 41, "correction", "{\"value\":41}"));
            assertThat(result.decision().targets().getFirst().fields())
                    .containsExactly(
                            new PublicationDecision.Field(
                                    "history", "historyBySequence", HISTORY_INSERTED, true, true),
                            new PublicationDecision.Field(
                                    "latest", "latestBySequence", LATEST_OLDER, false, false));
            assertThat(runtime.snapshot("aliases", "car").orElseThrow().data().get("history"))
                    .extracting(node -> node.path("publicationSequence").longValue())
                    .containsExactly(41L, 42L);
            assertThat(
                            runtime.snapshot("aliases", "car")
                                    .orElseThrow()
                                    .data()
                                    .get("latest")
                                    .path("publicationSequence")
                                    .longValue())
                    .isEqualTo(42);
        }
    }

    @Test
    void equivalentPublicPayloadStillHasARecordedRetainedUpdate() {
        try (var runtime = new ViewCoordinator(configuration("memory", 10))) {
            runtime.applyExplained(parse("fleet", "trip-1", "car", 1, "position", "{\"value\":7}"));
            var result =
                    runtime.applyExplained(
                            parse("fleet", "trip-1", "car", 2, "position", "{\"value\":7}"));
            assertThat(result.decision().targets().getFirst().fields())
                    .contains(
                            new PublicationDecision.Field(
                                    "arrival", "arrival", ARRIVAL_REPLACED, true, false),
                            new PublicationDecision.Field(
                                    "latest", "latestBySequence", LATEST_NEWER, true, false));
            assertThat(result.outcome().targets().getFirst().changedFields())
                    .contains("arrival", "latest");
        }
    }

    @Test
    void duplicateAfterDurableRestartDoesNotRepeatOriginalChangedTargets() {
        var config = configuration("sqlite", 10);
        var database = directory.resolve("restart.db").toString();
        PublicationOutcome original;
        try (var runtime = new ViewCoordinator(config, database)) {
            original = runtime.applyExplained(event(1)).outcome();
        }
        try (var runtime = new ViewCoordinator(config, database)) {
            var duplicate = runtime.applyExplained(event(1));
            assertThat(duplicate.outcome().reason()).isEqualTo("alreadyCommitted");
            assertThat(duplicate.outcome().targets()).isEqualTo(original.targets());
            assertThat(duplicate.decision().installed()).isFalse();
            assertThat(duplicate.decision().targets()).isEmpty();
            assertThat(duplicate.decision().version()).isEqualTo(original.version());
        }
    }

    @Test
    void rejectedLaterTargetDiscardsEarlierStagedUpdates() {
        var config =
                new RuntimeConfiguration(
                        2,
                        "memory",
                        10,
                        100,
                        1,
                        List.of(new RuntimeConfiguration.Source("fleet", "trip-1")),
                        List.of(
                                IdentityFixtures.view("arrival", "arrival"),
                                IdentityFixtures.view("history", "historyBySequence")));
        try (var runtime = new ViewCoordinator(config)) {
            runtime.applyExplained(event(1));
            var before = runtime.snapshot("arrival", "car");
            var frames = new ArrayList<ViewCoordinator.Snapshot>();
            runtime.listen(frames::add);
            var result = runtime.applyExplained(event(2));
            assertThat(result.outcome().reason()).isEqualTo("historyLimit");
            assertThat(result.decision().installed()).isFalse();
            assertThat(result.decision().targets()).isEmpty();
            assertThat(runtime.snapshot("arrival", "car")).isEqualTo(before);
            assertThat(frames).isEmpty();
        }
    }

    @Test
    void rejectionAndUnmatchedPublicationRemainDistinctFromIgnoredField() {
        try (var runtime = new ViewCoordinator(configuration("memory", 10))) {
            runtime.applyExplained(event(1));
            for (var publication :
                    List.of(
                            parse("unknown", "trip-1", "car", 2, "position", "{}"),
                            parse("fleet", "other", "car", 2, "position", "{}"),
                            parse("fleet", "trip-1", "car", 1, "position", "{\"value\":99}"))) {
                var result = runtime.applyExplained(publication);
                assertThat(result.outcome().status()).isEqualTo("rejected");
                assertThat(result.decision().reason()).isEqualTo(result.outcome().reason());
                assertThat(result.decision().installed()).isFalse();
                assertThat(result.decision().targets()).isEmpty();
            }
            var unmatched =
                    runtime.applyExplained(parse("fleet", "trip-1", "car", 2, "other", "{}"));
            assertThat(unmatched.outcome().status()).isEqualTo("applied");
            assertThat(unmatched.decision().installed()).isTrue();
            assertThat(unmatched.decision().targets()).isEmpty();
        }
    }

    @Test
    void failedInstallationNeverReturnsPreparedDecisionAndPostInstallFailureDoesNotUndoState() {
        for (boolean afterInstall : List.of(false, true)) {
            try (var runtime = new ViewCoordinator(configuration("memory", 10))) {
                StateStore original = (StateStore) ReflectionTestUtils.getField(runtime, "storage");
                var store = spy(original);
                ReflectionTestUtils.setField(runtime, "storage", store);
                doAnswer(
                                invocation -> {
                                    if (afterInstall) invocation.callRealMethod();
                                    throw new IllegalStateException(
                                            "installation boundary failure");
                                })
                        .when(store)
                        .install(any());
                assertThatThrownBy(() -> runtime.applyExplained(event(1)))
                        .isInstanceOf(IllegalStateException.class)
                        .hasMessage("installation boundary failure");
                assertThat(store.current().version()).isEqualTo(afterInstall ? 1 : 0);
            }
        }
    }

    @Test
    void unsupportedConfigurationFailsBeforeAnyStorageWork() {
        var base = configuration("memory", 10);
        var config =
                new RuntimeConfiguration(
                        2,
                        "memory",
                        10,
                        100,
                        10,
                        List.of(
                                new RuntimeConfiguration.Source(
                                        "fleet",
                                        "trip-1",
                                        new RuntimeConfiguration.Progress(
                                                "contiguousSequence", 1L, 10L, 10L))),
                        base.views());
        try (var runtime = new ViewCoordinator(config)) {
            var store = spy((StateStore) ReflectionTestUtils.getField(runtime, "storage"));
            ReflectionTestUtils.setField(runtime, "storage", store);
            assertThatThrownBy(() -> runtime.applyExplained(event(1)))
                    .isInstanceOf(IllegalArgumentException.class);
            verifyNoInteractions(store);
            assertThat(runtime.apply(event(1)).status()).isEqualTo("applied");
        }
    }

    @Test
    void eachUnsupportedPolicyIsRejectedAndRegistrationRefreshesCoverage() {
        var mapper = new JsonMapper();
        var base = mapper.valueToTree(configuration("memory", 10));
        var mutations =
                List.of(
                        new String[] {
                            "entities",
                            "{\"fleet\":{\"mode\":\"lookupEntity\",\"keys\":{\"car\":\"car\"}}}"
                        },
                        new String[] {
                            "publication",
                            "{\"mode\":\"requireContributions\",\"fields\":[\"arrival\"],\"maxPendingEntities\":10}"
                        },
                        new String[] {
                            "freshness", "{\"mode\":\"receiptAge\",\"staleAfterMillis\":50}"
                        },
                        new String[] {
                            "conflict", "{\"mode\":\"sourcePriority\",\"sources\":[\"fleet\"]}"
                        },
                        new String[] {
                            "facts",
                            "{\"revision\":\"latestFactRevision\",\"maxRetainedFacts\":10,\"minimumBirthSequence\":1}"
                        });
        for (var mutation : mutations) {
            var tree = base.deepCopy();
            var view = (tools.jackson.databind.node.ObjectNode) tree.path("views").get(0);
            var field =
                    (tools.jackson.databind.node.ObjectNode) view.path("fields").path("arrival");
            var destination =
                    List.of("entities", "publication").contains(mutation[0]) ? view : field;
            destination.set(mutation[0], mapper.readTree(mutation[1]));
            if (mutation[0].equals("facts")) field.put("mode", "activeFacts");
            if (mutation[0].equals("conflict")) field.put("mode", "latestBySequence");
            var config = mapper.treeToValue(tree, RuntimeConfiguration.class);
            config.validate();
            try (var runtime = new ViewCoordinator(config)) {
                assertThatThrownBy(() -> runtime.applyExplained(event(1)))
                        .as(mutation[0])
                        .isInstanceOf(IllegalArgumentException.class)
                        .hasMessageContaining("Publication explanations require");
            }
        }
        try (var runtime = new ViewCoordinator(configuration("memory", 10))) {
            runtime.applyExplained(event(1));
            runtime.define(
                    new RuntimeConfiguration.View(
                            "mapped",
                            Map.of(
                                    "value",
                                    new RuntimeConfiguration.Field("fleet", "position", "arrival")),
                            Map.of(
                                    "fleet",
                                    new RuntimeConfiguration.Entity(
                                            "lookupEntity", Map.of("car", "car")))));
            assertThatThrownBy(() -> runtime.applyExplained(event(2)))
                    .isInstanceOf(IllegalArgumentException.class);
            assertThat(runtime.apply(event(2)).status()).isEqualTo("applied");
        }
    }

    @Test
    void ordinaryReceiptSerializationContainsNoDecisionData() {
        try (var runtime = new ViewCoordinator(configuration("memory", 10))) {
            var result = runtime.applyExplained(event(1));
            var json = new JsonMapper().valueToTree(result.outcome());
            assertThat(json.has("decision")).isFalse();
            assertThat(json.has("update")).isFalse();
            assertThat(json.path("targets").get(0).path("fields").get(0).has("update")).isFalse();
        }
    }
}
