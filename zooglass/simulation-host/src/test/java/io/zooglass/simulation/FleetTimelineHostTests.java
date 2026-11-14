package io.zooglass.simulation;

import static io.zooglass.simulation.FleetTestSupport.*;
import static io.zooglass.simulation.HostProtocol.JSON;
import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;

class FleetTimelineHostTests {
    @ParameterizedTest
    @CsvSource({"false,false,false", "false,false,true", "false,true,false", "false,true,true",
            "true,false,false", "true,false,true", "true,true,false", "true,true,true"})
    void declarationOrderControlsViewEffectsWhileFieldsAndSubscribersHaveTheirOwnOrder(
            boolean reverseViews, boolean reverseFields, boolean reverseSources) throws Exception {
        var config = configuration();
        var fields = (ObjectNode) config.path("views").get(0).path("fields");
        // One event matches both fields, exposing lexical field-result order as well as view order.
        ((ObjectNode) fields.path("operation")).put("sourceId", "position").put("type", "position");
        if (reverseFields) {
            var position = fields.remove("position");
            fields.set("position", position);
        }
        if (reverseSources) reverse((ArrayNode) config.path("sources"));
        if (reverseViews) reverse((ArrayNode) config.path("views"));
        var views = reverseViews ? List.of("received-journey", "fleet-state")
                : List.of("fleet-state", "received-journey");
        try (var fixture = new FleetTestSupport()) {
            fixture.start(config);
            fixture.connect("feed", "source");
            fixture.connect("client-z", "client");
            fixture.connect("client-a", "client");
            for (String view : views) {
                fixture.subscribe("client-z", view);
                fixture.subscribe("client-a", view);
            }
            var response = fixture.publish("position", 40, "{\"x\":40}");
            var receipt = receipt(response);
            assertThat(receipt.path("changedViews")).isEqualTo(JSON.valueToTree(views));
            assertThat(receipt.path("targets")).isEqualTo(expectedTargets(views));
            assertThat(receipt.path("version").longValue()).isOne();

            var effects = new ArrayList<JsonNode>();
            response.path("effects").forEach(effects::add);
            effects.addAll(fixture.drain());
            assertThat(effects.stream().map(effect -> effect.path("kind").asString()))
                    .containsOnly("state", "schedule", "receipt", "handoff", "frame");
            assertThat(effects.stream().filter(effect -> !effect.path("kind").asString().equals("schedule"))
                    .map(FleetTimelineHostTests::effectIdentity)).containsExactly(
                            "state:" + views.get(0), "state:" + views.get(1), "receipt:feed",
                            "handoff:client-z:" + views.get(0), "handoff:client-a:" + views.get(0),
                            "frame:client-z:" + views.get(0), "frame:client-a:" + views.get(0),
                            "handoff:client-z:" + views.get(1), "handoff:client-a:" + views.get(1),
                            "frame:client-z:" + views.get(1), "frame:client-a:" + views.get(1));
            for (var state : effects.stream().filter(effect -> effect.path("kind").asString().equals("state"))
                    .map(FleetTestSupport::wire).toList()) {
                assertThat(state.path("version").longValue()).isOne();
                assertThat(state.path("entityId").asString()).isEqualTo("bus");
                if (state.path("viewId").asString().equals("fleet-state")) {
                    assertThat(state.path("data").size()).isEqualTo(2);
                    assertThat(state.path("data").path("operation")).isEqualTo(state.path("data").path("position"));
                    assertThat(state.path("data").path("position").path("publicationSequence").longValue()).isEqualTo(40);
                } else assertThat(sequences(state.path("data").path("positions"))).containsExactly(40L);
            }
            var observation = turn("observe-installed", 0);
            observation.set("observationTargets", JSON.readTree("""
                    [{"viewId":"received-journey","entityId":"bus"},
                     {"viewId":"fleet-state","entityId":"bus"}]
                    """));
            var installed = fixture.call(observation);
            assertThat(installed.path("snapshots").valueStream()
                    .map(node -> JSON.readTree(node.asString()).path("viewId").asString()))
                    .containsExactly("received-journey", "fleet-state");
        }
    }

    @Test
    void lateInputDuplicatesAndIdentityConflictsUseTheRealSequenceStrategies() throws Exception {
        try (var fixture = new FleetTestSupport()) {
            fixture.start(configuration());
            fixture.connect("feed", "source");
            fixture.publish("position", 40, "{\"x\":40}");
            fixture.publish("position", 42, "{\"x\":42}");
            var late = fixture.publish("position", 41, "{\"x\":41}");
            var receipt = receipt(late);
            assertThat(receipt.path("status").asString()).isEqualTo("applied");
            assertThat(receipt.path("targets").get(0).path("changedFields").size()).isZero();
            assertThat(receipt.path("targets").get(1).path("changedFields"))
                    .isEqualTo(JSON.readTree("[\"positions\"]"));
            var journey = states(late).stream().filter(state -> state.path("viewId").asString()
                    .equals("received-journey")).findFirst().orElseThrow();
            assertThat(sequences(journey.path("data").path("positions"))).containsExactly(40L, 41L, 42L);
            var duplicate = fixture.publish("position", 41, "{\"x\":41}");
            assertThat(receipt(duplicate).path("reason").asString()).isEqualTo("alreadyApplied");
            assertThat(receipt(duplicate).path("targets")).isEqualTo(receipt.path("targets"));
            assertThat(receipt(duplicate).path("version")).isEqualTo(receipt.path("version"));
            assertThat(duplicate.path("effects").size()).isOne();
            var conflict = fixture.publish("position", 41, "{\"x\":99}");
            assertThat(receipt(conflict).path("reason").asString()).isEqualTo("identityConflict");
            assertThat(conflict.path("effects").size()).isOne();
            assertThat(receipt(fixture.publish("position", 9_007_199_254_740_992L, "{}"))
                    .path("reason").asString()).isEqualTo("invalidEnvelope");
        }
    }

    @Test
    void historyCapacityRejectsTheWholePublicationAndSafeMaximumSequenceIsAccepted() throws Exception {
        try (var fixture = new FleetTestSupport()) {
            fixture.start(configuration().put("maxHistoryEntries", 2));
            fixture.connect("feed", "source");
            fixture.publish("position", 40, "{}");
            fixture.publish("position", 42, "{}");
            var rejected = fixture.publish("position", 41, "{}");
            assertThat(receipt(rejected).path("reason").asString()).isEqualTo("historyLimit");
            assertThat(rejected.path("effects").size()).isOne();
            assertThat(receipt(fixture.publish("operation", 9_007_199_254_740_991L, "{}"))
                    .path("status").asString()).isEqualTo("applied");
        }
    }

    @Test
    void sameTimeSourcesSettleBeforeWritersAndDeliverBothViewsToBothClients() throws Exception {
        try (var fixture = new FleetTestSupport()) {
            fixture.start(configuration());
            fixture.connect("feed", "source");
            for (String client : List.of("client-z", "client-a")) {
                fixture.connect(client, "client");
                fixture.subscribe(client, "fleet-state");
                fixture.subscribe(client, "received-journey");
            }
            var position = fixture.publish("position", 40, "{\"x\":40}");
            var operation = fixture.publish("operation", 100, "{\"route\":7}");
            assertThat(states(position).stream().map(state -> state.path("viewId").asString()))
                    .containsExactly("fleet-state", "received-journey");
            assertThat(states(operation).stream().map(state -> state.path("viewId").asString()))
                    .containsExactly("fleet-state");
            var frames = fixture.drain().stream().filter(effect -> effect.path("kind").asString().equals("frame")).toList();
            for (String client : List.of("client-z", "client-a")) {
                var received = frames.stream().filter(effect -> effect.path("session").asString().equals(client))
                        .map(FleetTestSupport::wire).toList();
                assertThat(received.stream().map(frame -> frame.path("viewId").asString()))
                        .containsExactly("fleet-state", "received-journey", "fleet-state");
                assertThat(received.stream().map(frame -> frame.path("version").longValue()))
                        .containsExactly(1L, 1L, 2L);
                var finalFrame = received.getLast();
                var data = finalFrame.path("data");
                assertThat(data.propertyNames()).containsExactlyInAnyOrder("position", "operation");
                assertThat(data.path("position").propertyNames()).containsExactly("x");
                assertThat(data.path("position").path("x").decimalValue()).isEqualByComparingTo("40");
                assertThat(data.path("operation").propertyNames()).containsExactly("route");
                assertThat(data.path("operation").path("route").decimalValue()).isEqualByComparingTo("7");
                var publicationSequences = finalFrame.path("publicationSequences");
                assertThat(publicationSequences.propertyNames()).containsExactlyInAnyOrder("position", "operation");
                assertThat(publicationSequences.path("position").isArray()).isTrue();
                assertThat(publicationSequences.path("operation").isArray()).isTrue();
                assertThat(publicationSequences.path("position").size()).isOne();
                assertThat(publicationSequences.path("operation").size()).isOne();
                assertThat(publicationSequences.path("position").get(0).decimalValue()).isEqualByComparingTo("40");
                assertThat(publicationSequences.path("operation").get(0).decimalValue()).isEqualByComparingTo("100");
            }
        }
    }

    private static List<JsonNode> states(JsonNode response) {
        return response.path("effects").valueStream().filter(effect -> effect.path("kind").asString().equals("state"))
                .map(FleetTestSupport::wire).toList();
    }

    private static List<Long> sequences(JsonNode history) {
        return history.valueStream().map(entry -> entry.path("publicationSequence").longValue()).toList();
    }

    private static String effectIdentity(JsonNode effect) {
        String kind = effect.path("kind").asString();
        if (kind.equals("receipt")) return kind + ":" + effect.path("session").asString();
        return kind + ":" + (kind.equals("state") ? "" : effect.path("session").asString() + ":")
                + wire(effect).path("viewId").asString();
    }

    private static JsonNode expectedTargets(List<String> views) {
        var fleet = JSON.readTree("""
                {"viewId":"fleet-state","entityId":"bus","status":"accepted","reason":null,
                 "changedFields":["operation","position"],"fields":[
                   {"field":"operation","status":"accepted","reason":null,"changed":true},
                   {"field":"position","status":"accepted","reason":null,"changed":true}]}
                """);
        var journey = JSON.readTree("""
                {"viewId":"received-journey","entityId":"bus","status":"accepted","reason":null,
                 "changedFields":["positions"],"fields":[
                   {"field":"positions","status":"accepted","reason":null,"changed":true}]}
                """);
        var result = JSON.createArrayNode();
        views.forEach(view -> result.add(view.equals("fleet-state") ? fleet : journey));
        return result;
    }

    private static void reverse(ArrayNode values) {
        var first = values.get(0);
        values.set(0, values.get(1));
        values.set(1, first);
    }
}
