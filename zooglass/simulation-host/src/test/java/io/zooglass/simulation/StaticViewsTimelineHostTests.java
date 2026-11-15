package io.zooglass.simulation;

import static io.zooglass.simulation.FleetTestSupport.turn;
import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.StaticViewsTestSupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

class StaticViewsTimelineHostTests {
    @Test
    void explicitProfileRunsMixedProductionStrategiesAndInstalledObservations() throws Exception {
        var host = new TimelineHost(HostProtocol.V2, false);
        var started = host.command(initialization(configuration()));
        assertThat(JSON.valueToTree(started).path("effects").isEmpty()).isTrue();
        host.command(turn("connect", 1).put("session", "feed").put("role", "source"));
        publish(host, 2, 2, "newer");
        publish(host, 3, 1, "older");
        var observed = JSON.valueToTree(host.command(turn("observe-installed", 4)
                .set("observationTargets", JSON.readTree("[{\"viewId\":\"readings\",\"entityId\":\"one\"}]"))));
        var data = JSON.readTree(observed.path("snapshots").get(0).asString()).path("data");
        // Installed snapshots retain contribution envelopes; ViewSnapshot.from unwraps public API data.
        assertThat(data).isEqualTo(JSON.readTree("""
                {"arrival":{"publicationSequence":1,"payload":{"value":"older"}},
                 "latest":{"publicationSequence":2,"payload":{"value":"newer"}},
                 "history":[{"publicationSequence":1,"payload":{"value":"older"}},
                            {"publicationSequence":2,"payload":{"value":"newer"}}]}
                """));
        var publicSnapshot = JSON.readTree(observed.path("projectedSnapshots").get(0).asString());
        assertThat(publicSnapshot.path("data")).isEqualTo(JSON.readTree("""
                {"arrival":{"value":"older"},"latest":{"value":"newer"},
                 "history":[{"value":"older"},{"value":"newer"}]}
                """));
        assertThat(publicSnapshot.path("publicationSequences")).isEqualTo(JSON.readTree("""
                {"arrival":[1],"latest":[2],"history":[1,2]}
                """));
        var rawSnapshot = JSON.readTree(observed.path("snapshots").get(0).asString());
        for (String field : new String[] {"viewId", "entityId", "version", "status", "provenance"})
            assertThat(publicSnapshot.path(field)).isEqualTo(rawSnapshot.path(field));
        assertThat(observed.path("effects").isEmpty()).isTrue();
        assertThat(observed.path("pendingTasks").intValue()).isZero();
        host.command(turn("shutdown", 5));
    }

    @Test
    void explicitStaticProfileStartsEvenWhenOldClassificationIsFleet() throws Exception {
        var host = new TimelineHost(HostProtocol.V2, false);
        host.command(initialization(FleetTestSupport.configuration()));
        host.command(turn("shutdown", 1));
    }

    @Test
    void startupChecksActualBytesAndCannotUsePriorInspectionAsAnAdmissionToken() throws Exception {
        var inspector = new TimelineHost(HostProtocol.V1, false);
        var report = JSON.valueToTree(inspector.command(inspection(configuration())));
        assertThat(report.path("requestedProfile").path("eligible").asBoolean()).isTrue();
        rejects(initialization(configuration().put("maxStreams", 21)), "$.maxStreams");
        var absent = initialization(configuration());
        absent.remove("profile");
        rejects(absent, "Unsupported document configuration profile");
        rejects(initialization(configuration()).put("profile", "future-profile"), "Unsupported document configuration profile");
        rejects(initialization(configuration()).put("runtimeGeneration", 2), "generation 1");
        rejects(initialization(configuration()).put("runtimeGeneration", 2).put("startTimeMs", 5)
                .put("timeMs", 5).put("wallMillis", FleetTestSupport.EPOCH + 5), "generation 1");
        rejects(initialization(configuration()).put("wallOffsetMillis", 1), "origin");
        rejects(initialization(configuration()).put("database", "/never-create.db"), "database path");
        assertThatThrownBy(() -> new TimelineHost(HostProtocol.V1, false).command(initialization(configuration())))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("field");
    }

    @Test
    void clockFaultAndControlRejectionsDoNotAdvanceOrPoisonTheRunningHost() throws Exception {
        var host = new TimelineHost(HostProtocol.V2, false);
        host.command(initialization(configuration()));
        for (String op : new String[] {"wall-clock-set", "stall", "release", "progress", "retirement"}) {
            var command = turn(op, 1).put("wallMillis", FleetTestSupport.EPOCH - 1);
            if (op.equals("stall") || op.equals("release")) command.put("session", "absent");
            if (op.equals("release")) command.put("fail", false);
            if (op.equals("progress") || op.equals("retirement")) command.put("session", "absent").put("wire", "{}");
            assertThatThrownBy(() -> host.command(command))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Static views profile");
        }
        var observed = JSON.valueToTree(host.command(turn("observe", 1)));
        assertThat(observed.path("wallMillis").longValue()).isEqualTo(FleetTestSupport.EPOCH);
        assertThat(observed.path("effects").isEmpty()).isTrue();
        assertThat(observed.path("pendingTasks").intValue()).isZero();
        host.command(turn("shutdown", 2));
    }

    private static void publish(TimelineHost host, long turn, long sequence, String value) throws Exception {
        var wire = JSON.createObjectNode().put("sourceId", "feed").put("epoch", "v1")
                .put("sourceEntityId", "one").put("publicationSequence", sequence).put("type", "sample")
                .set("payload", JSON.createObjectNode().put("value", value));
        var response = JSON.valueToTree(host.command(turn("ingress", turn).put("session", "feed").put("wire", wire.toString())));
        assertThat(FleetTestSupport.receipt(response).path("status").asString()).isEqualTo("applied");
    }

    private static void rejects(ObjectNode command, String message) {
        assertThatThrownBy(() -> new TimelineHost(HostProtocol.V2, false).command(command))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining(message);
    }
}
