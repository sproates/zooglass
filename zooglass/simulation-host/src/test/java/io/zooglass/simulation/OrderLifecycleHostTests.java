package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.OrderTestSupport.EPOCH;
import static io.zooglass.simulation.OrderTestSupport.receipt;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.runtime.TimelineProfile;
import io.zooglass.runtime.TimelineRuntime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;

class OrderLifecycleHostTests {
    @TempDir Path directory;

    @Test void executionCapabilityDoesNotReclassifyTheConfiguration() throws Exception {
        assertThat(TimelineProfile.inspect(TimelineRuntime.inspectConfiguration(
                OrderTestSupport.configuration().toString()))).isEqualTo(TimelineProfile.SQLITE_ORDER);
        assertThat(HostProtocol.V2.handshake("hash", "3")).containsEntry("sqliteOrderLifecycle", 1);
        assertThat(HostProtocol.V2.handshake("hash", null)).doesNotContainKey("sqliteOrderLifecycle");
        assertThat(HostProtocol.V1.handshake("hash", "3")).doesNotContainKey("sqliteOrderLifecycle");
    }

    @Test void aNewHostRecoversWatermarkAndReturnsItsOriginalVersion() throws Exception {
        var database = directory.resolve("recover.db");
        var first = new TimelineHost(HostProtocol.V2, true);
        call(first, initialization(database, 1, 0, 0));
        try {
            call(first, turn("connect", 1, 1, 0, 0).put("session", "p").put("role", "progress"));
            var committed = receipt(call(first, progress(2, 1, 0, 10, 3)), "control-receipt");
            assertThat(committed).isEqualTo(JSON.readTree("""
                    {"kind":"watermark","status":"committed","reason":"sqlite",
                     "stream":{"sourceId":"orders","epoch":"run","sourceEntityId":"order-1"},
                     "throughSequence":3,"version":1,"changedViews":["order-summary","order-tracking"]}
                    """));
        } finally {
            call(first, turn("shutdown", 3, 1, 0, 11));
        }

        var second = new TimelineHost(HostProtocol.V2, true);
        var recovered = call(second, initialization(database, 2, 4, 20));
        try {
            assertThat(recovered.path("monotonicMs").longValue()).isZero();
            assertThat(recovered.path("wallMillis").longValue()).isEqualTo(EPOCH + 20);
            assertThat(recovered.path("effects").size()).isZero();
            assertThat(recovered.path("pendingTasks").intValue()).isZero();
            var installed = JSON.readTree(recovered.path("snapshots").get(0).asString());
            assertThat(installed.path("version").longValue()).isOne();
            assertThat(installed.path("data").size()).isZero();
            assertThat(installed.at("/status/inputs/orders/watermarkThrough").longValue()).isEqualTo(3);
            assertThat(installed.at("/status/inputs/orders/missingRanges")).isEqualTo(JSON.readTree(
                    "[{\"from\":1,\"through\":3,\"status\":\"confirmed\"}]"));
            call(second, turn("connect", 5, 2, 20, 20).put("session", "p").put("role", "progress"));
            var duplicateResponse = call(second, progress(6, 2, 20, 20, 3));
            var duplicate = receipt(duplicateResponse, "control-receipt");
            assertThat(duplicate).isEqualTo(JSON.readTree("""
                    {"kind":"watermark","status":"duplicate","reason":"alreadyCommitted",
                     "stream":{"sourceId":"orders","epoch":"run","sourceEntityId":"order-1"},
                     "throughSequence":3,"version":1,"changedViews":[]}
                    """));
            assertThat(duplicateResponse.path("effects").size()).isOne();
            assertThat(receipt(call(second, progress(7, 2, 20, 21, 4)), "control-receipt")
                    .path("version").longValue()).isEqualTo(2);
        } finally {
            call(second, turn("shutdown", 8, 2, 20, 21));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"initial-time", "initial-offset", "restart-offset", "existing-initial",
            "missing-restart", "directory-restart", "symlink-restart", "ordinary-restart", "wrong-profile", "unavailable", "v1"})
    void unsupportedInitializationCannotCreateOrOverwriteAStore(String change) throws Exception {
        var database = directory.resolve("state.db");
        boolean restart = change.contains("restart");
        var command = initialization(database, restart ? 2 : 1, 0, restart ? 20 : 0);
        if (change.equals("initial-time")) command.put("startTimeMs", 5).put("timeMs", 5).put("wallMillis", EPOCH + 5);
        if (change.endsWith("offset")) command.put("wallOffsetMillis", 1).put("wallMillis", EPOCH + (restart ? 20 : 0) + 1);
        if (change.equals("existing-initial") || change.equals("restart-offset") || change.equals("ordinary-restart"))
            Files.writeString(database, "preserved");
        if (change.equals("directory-restart")) Files.createDirectory(database);
        if (change.equals("symlink-restart")) {
            var target = directory.resolve("target.db");
            Files.writeString(target, "preserved");
            Files.createSymbolicLink(database, target);
        }
        if (change.equals("ordinary-restart")) command.put("profile", TimelineProfile.SQLITE_ORDER);
        if (change.equals("wrong-profile")) command.put("profile", "sqlite-order-unqualified-v1");
        var host = new TimelineHost(change.equals("v1") ? HostProtocol.V1 : HostProtocol.V2, !change.equals("unavailable"));
        assertThatThrownBy(() -> call(host, command)).isInstanceOf(IllegalArgumentException.class);
        if (Files.isRegularFile(database)) assertThat(Files.readString(database)).isEqualTo("preserved");
        else if (!change.equals("directory-restart")) assertThat(Files.exists(database)).isFalse();
    }

    @Test void restartProfileStillRejectsWallClockAdjustment() throws Exception {
        var host = new TimelineHost(HostProtocol.V2, true);
        call(host, initialization(directory.resolve("wall.db"), 1, 0, 0));
        try {
            assertThatThrownBy(() -> call(host, turn("wall-clock-set", 1, 1, 0, 0).put("wallMillis", EPOCH + 1)))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("wall-clock adjustments");
        } finally {
            call(host, turn("shutdown", 1, 1, 0, 0));
        }
    }

    @Test void restartExecutionCannotRelabelAnOtherwiseSupportedArrivalConfiguration() throws Exception {
        String configuration = """
                {"contractVersion":2,"storage":"sqlite","maxStreams":20,"identityWindow":20,
                 "maxHistoryEntries":20,"sources":[{"id":"feed","epoch":"run"}],"views":[
                  {"id":"stock","fields":{"value":{"sourceId":"feed","type":"value",
                   "mode":"arrival","freshness":{"mode":"receiptAge","staleAfterMillis":100}}}}]}
                """;
        assertThat(TimelineProfile.inspect(TimelineRuntime.inspectConfiguration(configuration)))
                .isEqualTo(TimelineProfile.SQLITE_RESTART);
        var database = directory.resolve("wrong-configuration.db");
        var command = initialization(database, 1, 0, 0).put("wire", configuration);
        command.remove("observationTargets");
        assertThatThrownBy(() -> call(new TimelineHost(HostProtocol.V2, true), command))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("profile agreement");
        assertThat(database).doesNotExist();
    }

    private static ObjectNode initialization(Path database, long generation, long id, long start) throws Exception {
        var command = turn("initialize-document", id, generation, start, start)
                .put("startTimeMs", start).put("epochMillis", EPOCH).put("database", database.toString())
                .put("profile", TimelineProfile.SQLITE_ORDER_RESTART).put("wire", OrderTestSupport.configuration().toString());
        command.set("observationTargets", JSON.readTree("[{\"viewId\":\"order-summary\",\"entityId\":\"order-1\"}]"));
        return command;
    }

    private static ObjectNode progress(long id, long generation, long start, long time, long through) {
        return turn("progress", id, generation, start, time).put("session", "p").put("wire",
                JSON.createObjectNode().put("sourceId", "orders").put("epoch", "run")
                        .put("sourceEntityId", "order-1").put("throughSequence", through).toString());
    }

    private static ObjectNode turn(String op, long id, long generation, long start, long time) {
        return JSON.createObjectNode().put("op", op).put("turnId", id).put("runtimeGeneration", generation)
                .put("timeMs", time).put("monotonicMs", time - start).put("wallMillis", EPOCH + time);
    }

    private static JsonNode call(TimelineHost host, ObjectNode command) throws Exception {
        return JSON.valueToTree(host.command(command));
    }
}
