package io.zooglass.simulation;

import static io.zooglass.simulation.FleetTestSupport.turn;
import static io.zooglass.simulation.FleetTestSupport.wire;
import static io.zooglass.simulation.HostProtocol.JSON;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.runtime.StaticRecoveryTimelineProfile;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;

class PublicationDecisionHostTests {
    @Test
    void bothHandshakeProtocolsAdvertiseDecisionSupport() {
        assertThat(HostProtocol.V1.handshake("artifact", null))
                .containsEntry("publicationDecisions", 1);
        assertThat(HostProtocol.V2.handshake("artifact", null))
                .containsEntry("publicationDecisions", 1);
    }

    @Test
    void decisionsAreOptInAndDoNotChangeExistingEffects() throws Exception {
        try (var ordinary = new FleetTestSupport();
                var explained = new FleetTestSupport()) {
            ordinary.call(initialization());
            explained.call(initialization().put("publicationDecisions", true));
            ordinary.connect("feed", "source");
            explained.connect("feed", "source");

            var normal = ordinary.call(publication(2));
            var detailed = explained.call(publication(2));
            assertThat(withoutDecision(detailed)).isEqualTo(withoutDecision(normal));
            assertThat(decisions(normal)).isEmpty();
            var result = decision(detailed);
            assertThat(result.path("availability").asString()).isEqualTo("recorded");
            var details = result.path("decision");
            assertThat(details.path("format").asString()).isEqualTo("publication-decision/v1");
            assertThat(details.path("installed").asBoolean()).isTrue();
            assertThat(details.path("targets").get(0).path("fields").size()).isEqualTo(3);

            var older = decision(explained.call(publication(1))).path("decision");
            assertThat(updates(older))
                    .containsExactly("ARRIVAL_REPLACED", "HISTORY_INSERTED", "LATEST_OLDER");
            var retry = decision(explained.call(publication(1))).path("decision");
            assertThat(retry.path("status").asString()).isEqualTo("duplicate");
            assertThat(retry.path("installed").asBoolean()).isFalse();
            assertThat(retry.path("targets").isEmpty()).isTrue();
        }
    }

    @Test
    void malformedInputIsUnavailableWhileSemanticRejectionStillHasADecision() throws Exception {
        try (var run = new FleetTestSupport()) {
            run.call(initialization().put("publicationDecisions", true));
            run.connect("feed", "source");
            var malformed = run.call(turn("ingress", 0).put("session", "feed").put("wire", "{}"));
            assertThat(decision(malformed))
                    .isEqualTo(
                            JSON.readTree(
                                    """
                                    {"availability":"unavailable","reason":"invalidEnvelope"}
                                    """));
            assertThat(FleetTestSupport.receipt(malformed).path("reason").asString())
                    .isEqualTo("invalidEnvelope");
            var command = publication(1);
            command.put("wire", command.path("wire").asString().replace("\"feed\"", "\"unknown\""));
            var rejected = decision(run.call(command));
            assertThat(rejected.path("availability").asString()).isEqualTo("recorded");
            assertThat(rejected.path("decision").path("status").asString()).isEqualTo("rejected");
            assertThat(rejected.path("decision").path("installed").asBoolean()).isFalse();
            assertThat(rejected.path("decision").path("targets").isEmpty()).isTrue();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"false", "1", "\"true\""})
    void rejectsInvalidDecisionOptInBeforeComposition(String flag) {
        var command = initialization();
        command.set("publicationDecisions", JSON.readTree(flag));
        var host = new TimelineHost(HostProtocol.V2, false);
        assertThatThrownBy(() -> host.command(command))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Publication decisions require explicit true");
    }

    @Test
    void rejectsDecisionOptInOutsideTheRecoveryProfile() {
        var command =
                StaticViewsTestSupport.initialization(StaticViewsTestSupport.configuration())
                        .put("publicationDecisions", true);
        var host = new TimelineHost(HostProtocol.V2, false);
        assertThatThrownBy(() -> host.command(command))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("static recovery profile");
        assertThatThrownBy(() -> HostProtocol.V1.validateFields(command, "initialize-document"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static ObjectNode initialization() {
        return StaticViewsTestSupport.initialization(StaticViewsTestSupport.configuration())
                .put("profile", StaticRecoveryTimelineProfile.NAME);
    }

    private static ObjectNode publication(long sequence) {
        var publication =
                JSON.createObjectNode()
                        .put("sourceId", "feed")
                        .put("epoch", "v1")
                        .put("sourceEntityId", "bus")
                        .put("publicationSequence", sequence)
                        .put("type", "sample");
        publication.set("payload", JSON.readTree("{\"value\":1}"));
        return turn("ingress", 0).put("session", "feed").put("wire", publication.toString());
    }

    private static List<JsonNode> decisions(JsonNode response) {
        var results = new ArrayList<JsonNode>();
        for (var effect : response.path("effects"))
            if (effect.path("kind").asString().equals("publication-decision")) {
                assertThat(effect.path("session").asString()).isEqualTo("feed");
                results.add(wire(effect));
            }
        return results;
    }

    private static JsonNode decision(JsonNode response) {
        var results = decisions(response);
        assertThat(results).hasSize(1);
        return results.getFirst();
    }

    private static List<JsonNode> withoutDecision(JsonNode response) {
        var effects = new ArrayList<JsonNode>();
        for (var effect : response.path("effects"))
            if (!effect.path("kind").asString().equals("publication-decision")) effects.add(effect);
        return effects;
    }

    private static List<String> updates(JsonNode decision) {
        var updates = new ArrayList<String>();
        for (var field : decision.path("targets").get(0).path("fields"))
            updates.add(field.path("update").asString());
        return updates;
    }
}
