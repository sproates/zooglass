package io.zooglass.v2;

import static io.zooglass.v2.FactFixtures.configuration;
import static io.zooglass.v2.FactFixtures.event;
import static io.zooglass.v2.FactFixtures.snapshot;
import static io.zooglass.v2.FactFixtures.view;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

class FactCompositionTests {

    @Test
    void watermarkUsesTheCorrectionPublicationAndLatePolicyRemainsPerField() {
        var base = configuration("memory", 10, true);
        var accept = base.views().getLast().fields().get("goals");
        var reject =
                new V2Configuration.Field(
                        "match",
                        "goal",
                        "activeFacts",
                        null,
                        null,
                        new V2Configuration.Late("rejectBehindWatermark"),
                        accept.freshness(),
                        accept.facts());
        var config =
                new V2Configuration(
                        2,
                        "memory",
                        10,
                        10,
                        20,
                        base.sources(),
                        List.of(
                                new V2Configuration.View(
                                        "mixed", Map.of("accept", accept, "reject", reject))));
        try (var service = new ViewCoordinator(config)) {
            service.apply(event(1, 1, 1, "create", "{}"));
            service.advance(new ProgressControl("match", "v1", "game", 5));
            assertThat(
                            service.apply(event(6, 1, 3, "revise", "{}"))
                                    .targets()
                                    .getFirst()
                                    .changedFields())
                    .containsExactly("accept", "reject");
            var delayed = service.apply(event(4, 1, 4, "retract", "{}"));
            assertThat(delayed.targets().getFirst().fields().getLast().reason())
                    .isEqualTo("behindWatermark");
            var view = snapshot(service, "mixed");
            assertThat(view.data().get("accept")).isEmpty();
            assertThat(view.data().get("reject")).hasSize(1);
            assertThat(view.status().inputs().get("match").sourceContractViolated()).isTrue();
        }
    }

    @Test
    void emptyCollectionsRemainRequiredContributionsAndSnapshotsAreDetached() {
        var base = configuration("memory", 10, false);
        var view = base.views().getLast();
        var required =
                new V2Configuration.View(
                        view.id(),
                        view.fields(),
                        null,
                        new V2Configuration.Exposure("requireContributions", List.of("goals"), 1L));
        var config =
                new V2Configuration(2, "memory", 10, 10, 20, base.sources(), List.of(required));
        try (var service = new ViewCoordinator(config)) {
            assertThat(snapshot(service, "corrected").status().publication()).isEqualTo("waiting");
            var create = event(1, 1, 1, "create", "{\"label\":\"goal\"}");
            service.apply(create);
            ((tools.jackson.databind.node.ObjectNode) create.payload())
                    .put("label", "mutated input");
            var external = snapshot(service, "corrected").data().get("goals");
            ((tools.jackson.databind.node.ObjectNode) external.get(0).path("payload"))
                    .put("label", "mutated output");
            assertThat(
                            snapshot(service, "corrected")
                                    .data()
                                    .get("goals")
                                    .get(0)
                                    .path("payload")
                                    .path("label")
                                    .asText())
                    .isEqualTo("goal");
            service.apply(event(2, 1, 2, "retract", "{}"));
            assertThat(snapshot(service, "corrected").status().publication()).isEqualTo("ready");
            assertThat(snapshot(service, "corrected").data().get("goals")).isEmpty();
        }
    }

    @Test
    void retirementResolvesMappingsAndAccountsForEmptyPendingEntities() {
        var base = configuration("memory", 10, false);
        var field = base.views().getLast().fields().get("goals");
        var view =
                new V2Configuration.View(
                        "mapped",
                        Map.of("goals", field),
                        Map.of(
                                "match",
                                new V2Configuration.Entity(
                                        "lookupEntity", Map.of("game", "A", "other", "B"))),
                        new V2Configuration.Exposure("requireContributions", List.of("goals"), 1L));
        var config = new V2Configuration(2, "memory", 1, 10, 20, base.sources(), List.of(view));
        try (var service = new ViewCoordinator(config)) {
            assertThat(
                            service.retire(
                                            new FactRetirement(
                                                    "mapped", "unknown", List.of("goals"), 2))
                                    .reason())
                    .isEqualTo("unknownEntityMapping");
            assertThat(
                            service.retire(new FactRetirement("mapped", "A", List.of("goals"), 2))
                                    .status())
                    .isEqualTo("applied");
            assertThat(
                            service.retire(new FactRetirement("mapped", "B", List.of("goals"), 2))
                                    .reason())
                    .isEqualTo("streamLimit");
            // A no-op at the configured floor needs no stream or pending slot.
            assertThat(
                            service.retire(new FactRetirement("mapped", "B", List.of("goals"), 1))
                                    .status())
                    .isEqualTo("unchanged");
            assertThat(service.apply(event(2, 2, 1, "create", "{}")).status()).isEqualTo("applied");
            assertThat(service.snapshot("mapped", "A").orElseThrow().status().publication())
                    .isEqualTo("ready");
        }
    }

    @Test
    void newEmptyViewCannotConsumeACorrectionBeforeItsCreate() {
        var base = configuration("memory", 10, false);
        var ordinary =
                new V2Configuration.View(
                        "plain",
                        Map.of("goal", new V2Configuration.Field("match", "goal", "arrival")));
        var field = base.views().getLast().fields().get("goals");
        var late =
                new V2Configuration.Field(
                        "match",
                        "goal",
                        "activeFacts",
                        null,
                        null,
                        new V2Configuration.Late("rejectBehindWatermark"),
                        field.freshness(),
                        field.facts());
        var config =
                new V2Configuration(
                        2,
                        "memory",
                        10,
                        10,
                        20,
                        base.sources(),
                        List.of(
                                ordinary,
                                new V2Configuration.View("facts", Map.of("goals", late))));
        try (var service = new ViewCoordinator(config)) {
            service.advance(new ProgressControl("match", "v1", "game", 1));
            service.apply(
                    event(
                            1, 1, 1, "create",
                            "{}")); // Ordinary target receives it, fact target rejects late create.
            var before = snapshot(service, "plain");
            var correction = event(2, 1, 2, "revise", "{}");
            assertThat(service.apply(correction).reason()).isEqualTo("unknownFact");
            assertThat(snapshot(service, "plain")).isEqualTo(before);
            assertThat(snapshot(service, "facts").status().inputs().get("match").observedThrough())
                    .isEqualTo(1);
        }
    }
}
