package io.zooglass.simulation;

import static io.zooglass.simulation.FleetTestSupport.turn;
import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.StaticViewsTestSupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.runtime.TimelineProfile;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

class RequestedProfileAdmissionTests {
    @Test
    void advertisesAdmissionWithoutClaimingV3ExecutionAndPreservesLegacyInspection() throws Exception {
        for (var protocol : HostProtocol.values()) {
            var handshake = protocol.handshake("digest", null);
            assertThat(handshake).containsEntry("memoryStaticViews", 1);
            assertThat(handshake.get("documentFormats").toString()).doesNotContain("v3");
        }
        var host = new TimelineHost(HostProtocol.V1, false);
        var config = FleetTestSupport.configuration();
        var requested = JSON.valueToTree(host.command(inspection(config)));
        assertThat(requested.path("requestedProfile").path("eligible").asBoolean()).isTrue();
        assertThat(requested.path("configuration").path("documentProfile").asString())
                .isEqualTo(TimelineProfile.MEMORY_SEQUENCE_FLEET);
        assertThat(requested.path("effects").isEmpty()).isTrue();
        assertThat(requested.path("pendingTasks").intValue()).isZero();
        assertThat(requested.path("heldFrames").intValue()).isZero();
        var old = JSON.valueToTree(host.command(turn("inspect-configuration", 1).put("wire", config.toString())));
        assertThat(old.has("requestedProfile")).isFalse();
        assertThat(old.path("configuration")).isEqualTo(requested.path("configuration"));
        // Inspection has not initialized a runtime or consumed its initialization opportunity.
        var started = JSON.valueToTree(host.command(turn("initialize", 2).put("policy", "disconnectOnOverflow")));
        assertThat(started.path("effects").isEmpty()).isTrue();
        host.command(turn("shutdown", 3));
    }

    @Test
    void comparesProductionDefaultsAndInputNormalizationWhileIgnoringOnlyResourceBounds() throws Exception {
        var reference = configuration().put("maxStreams", 100_000).put("identityWindow", 10_000)
                .put("maxHistoryEntries", 10_000);
        var supplied = configuration();
        field(reference, "arrival").remove("sourceId");
        field(reference, "arrival").remove("type");
        field(reference, "arrival").set("inputs", JSON.readTree("[{\"sourceId\":\"feed\",\"type\":\"sample\"}]"));
        field(supplied, "arrival").set("late", JSON.readTree("{\"mode\":\"acceptLate\"}"));
        field(supplied, "arrival").set("freshness", JSON.readTree("{\"mode\":\"unspecified\"}"));
        field(supplied, "arrival").set("conflict", JSON.readTree("{\"mode\":\"independentFields\"}"));
        ((ObjectNode) supplied.path("sources").get(0)).set("progress", JSON.readTree("{\"mode\":\"untracked\"}"));
        ((ObjectNode) supplied.path("views").get(0)).set("publication", JSON.readTree("{\"mode\":\"publishPartial\"}"));
        ((ObjectNode) supplied.path("views").get(0)).set("entities", JSON.readTree("{\"feed\":{\"mode\":\"envelopeEntity\"}}"));
        supplied.set("delivery", JSON.readTree("""
                {"recovery":"freshSnapshot","slowClient":"disconnectOnOverflow","maxQueuedMessages":2,"maxQueuedBytes":64}
                """));
        var report = requested(inspection(supplied).put("referenceWire", reference.toString()));
        assertThat(report.path("eligible").asBoolean()).isTrue();
        assertThat(report.path("comparison").path("equivalent").asBoolean()).isTrue();
        assertThat(report.path("comparison").path("differences").isEmpty()).isTrue();

        StaticViewsProfileTests.aliases(field(reference, "arrival"), "feed", "z", "feed", "a");
        StaticViewsProfileTests.aliases(field(supplied, "arrival"), "feed", "a", "feed", "z");
        assertThat(requested(inspection(supplied).put("referenceWire", reference.toString()))
                .path("comparison").path("equivalent").asBoolean()).isTrue();
    }

    @Test
    void reportsSemanticDifferencesEvenWhenBothConfigurationsFitTheFamily() throws Exception {
        var supplied = configuration();
        field(supplied, "arrival").put("mode", "latestBySequence");
        ((ObjectNode) supplied.path("sources").get(0)).put("epoch", "different");
        supplied.set("delivery", JSON.readTree("{\"slowClient\":\"coalesceLatestState\"}"));
        var report = requested(inspection(supplied).put("referenceWire", configuration().toString()));
        assertThat(report.path("eligible").asBoolean()).isTrue();
        assertThat(report.path("comparison").path("equivalent").asBoolean()).isFalse();
        assertThat(paths(report.path("comparison").path("differences")))
                .containsExactly("$[\"delivery\"][\"slowClient\"]", "$[\"sources\"][0][\"epoch\"]",
                        "$[\"views\"][0][\"fields\"][\"arrival\"][\"mode\"]");
    }

    @Test
    void semanticComparisonDoesNotWhitelistNestedNamesThatResembleResourceBounds() throws Exception {
        var reference = configuration();
        var supplied = configuration();
        ((ObjectNode) reference.path("views").get(0).path("fields")).set("maxStreams",
                ((ObjectNode) reference.path("views").get(0).path("fields")).remove("arrival"));
        ((ObjectNode) supplied.path("views").get(0).path("fields")).set("maxStreams",
                ((ObjectNode) supplied.path("views").get(0).path("fields")).remove("arrival"));
        field(supplied, "maxStreams").put("mode", "latestBySequence");
        var report = requested(inspection(supplied).put("referenceWire", reference.toString()));
        assertThat(paths(report.path("comparison").path("differences")))
                .containsExactly("$[\"views\"][0][\"fields\"][\"maxStreams\"][\"mode\"]");
    }

    @Test
    void separatesIneligibleConfigurationFromComparisonAndRejectsMalformedReference() throws Exception {
        var wide = configuration().put("maxStreams", 21);
        var report = requested(inspection(wide).put("referenceWire", configuration().toString()));
        assertThat(report.path("eligible").asBoolean()).isFalse();
        assertThat(paths(report.path("issues"))).containsExactly("$.maxStreams");
        assertThat(report.path("comparison").path("equivalent").asBoolean()).isTrue();
        assertThat(requested(inspection(configuration())).has("comparison")).isFalse();
        var unknown = requested(inspection(configuration()).put("profile", "future-profile"));
        assertThat(unknown.path("eligible").asBoolean()).isFalse();
        assertThat(paths(unknown.path("issues"))).containsExactly("$.profile");
        assertThatThrownBy(() -> requested(inspection(configuration()).put("referenceWire",
                configuration().put("identityWindow", 0).toString())))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"profile", "wire", "referenceWire"})
    void rejectsWrongFieldTypes(String field) {
        var command = inspection(configuration()).put(field, false);
        assertThatThrownBy(() -> requested(command)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void inspectionCannotBeUsedAfterStartupOrOnAV2Host() throws Exception {
        assertThatThrownBy(() -> new TimelineHost(HostProtocol.V2, false).command(inspection(configuration())))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unstarted v1");
        var host = new TimelineHost(HostProtocol.V1, false);
        host.command(turn("initialize", 0).put("policy", "disconnectOnOverflow"));
        assertThatThrownBy(() -> host.command(inspection(configuration()).put("turnId", 1)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unstarted v1");
        host.command(turn("shutdown", 1));
        assertThatThrownBy(() -> requested(inspection(configuration()).put("database", "/never-create.db")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("field");
    }

    private static JsonNode requested(ObjectNode command) throws Exception {
        return JSON.valueToTree(new TimelineHost(HostProtocol.V1, false).command(command)).path("requestedProfile");
    }

    private static java.util.List<String> paths(JsonNode issues) {
        return issues.valueStream().map(issue -> issue.path("path").asString()).toList();
    }
}
