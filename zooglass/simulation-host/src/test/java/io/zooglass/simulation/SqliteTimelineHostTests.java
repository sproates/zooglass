package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;

class SqliteTimelineHostTests {
    private static final long EPOCH = 1_700_000_000_000L;
    private static final String CONFIGURATION = """
            {"contractVersion":2,"storage":"sqlite","maxStreams":20,"identityWindow":20,
             "maxHistoryEntries":20,"sources":[{"id":"feed","epoch":"v1"}],"views":[
               {"id":"position","fields":{"position":{"sourceId":"feed","type":"position",
                 "mode":"arrival","freshness":{"mode":"receiptAge","staleAfterMillis":50}}}}]}
            """;
    private static final String PUBLICATION = """
            {"sourceId":"feed","epoch":"v1","sourceEntityId":"bus","publicationSequence":1,
             "type":"position","payload":{"coordinate":9007199254740993}}
            """;

    @TempDir Path directory;

    @ParameterizedTest
    @CsvSource({"40, fresh, 1, 1", "60, stale, 2, 0"})
    void restartReadsInstalledStateAndPreservesTheOriginalReceipt(
            long restartAt, String freshness, long recoveredVersion, int pending) throws Exception {
        var database = directory.resolve("restart.db");
        var first = new TimelineHost(HostProtocol.V2, true);
        var initial = start(first, database, 1, 0, 0);
        assertThat(JSON.readTree(initial.path("snapshots").get(0).asString())
                .path("version").longValue()).isZero();
        connect(first, 1, 1, 0, 0);
        var committed = receipt(publish(first, 2, 1, 0, 10));
        assertThat(committed.path("status").asString()).isEqualTo("committed");
        assertThat(committed.path("version").longValue()).isOne();
        call(first, turn("shutdown", 3, 1, 0, 11));

        var second = new TimelineHost(HostProtocol.V2, true);
        var recovered = start(second, database, 2, 4, restartAt);
        var installed = JSON.readTree(recovered.path("snapshots").get(0).asString());
        var absent = JSON.readTree(recovered.path("snapshots").get(1).asString());
        assertThat(recovered.path("monotonicMs").longValue()).isZero();
        assertThat(recovered.path("wallMillis").longValue()).isEqualTo(EPOCH + restartAt);
        assertThat(installed.path("entityId").asString()).isEqualTo("bus");
        assertThat(installed.path("version").longValue()).isEqualTo(recoveredVersion);
        var contribution = installed.path("data").path("position");
        assertThat(contribution.path("publicationSequence").longValue()).isOne();
        assertThat(contribution.path("payload").path("coordinate").longValue())
                .isEqualTo(9_007_199_254_740_993L);
        var field = installed.path("status").path("fields").path("position");
        assertThat(field.path("freshness").asString()).isEqualTo(freshness);
        assertThat(field.path("receivedAtMillis").longValue()).isEqualTo(EPOCH + 10);
        assertThat(absent.path("entityId").asString()).isEqualTo("other");
        assertThat(absent.path("version").longValue()).isZero();
        assertThat(recovered.path("pendingTasks").intValue()).isEqualTo(pending);
        var effects = recovered.path("effects");
        assertThat(effects.size()).isEqualTo(pending);
        if (pending == 1) {
            assertThat(effects.get(0).path("taskKind").asString()).isEqualTo("alarm");
            assertThat(effects.get(0).path("at").longValue()).isEqualTo(60);
        }

        connect(second, 5, 2, restartAt, restartAt);
        var duplicateResponse = publish(second, 6, 2, restartAt, restartAt);
        var duplicate = receipt(duplicateResponse);
        assertThat(duplicate.path("status").asString()).isEqualTo("duplicate");
        assertThat(duplicate.path("reason").asString()).isEqualTo("alreadyCommitted");
        assertThat(duplicate.path("version").longValue()).isOne();
        assertThat(duplicate.path("targets")).isEqualTo(committed.path("targets"));
        assertThat(duplicateResponse.path("effects").size()).isOne();
        call(second, turn("shutdown", 7, 2, restartAt, restartAt));
    }

    @Test
    void inspectionAndInvalidTargetsDoNotOpenAStore() throws Exception {
        var inspect = new TimelineHost(HostProtocol.V1, false);
        var result = call(inspect, turn("inspect-configuration", 0, 1, 0, 0)
                .put("wallMillis", 1_000_000).put("wire", CONFIGURATION));
        assertThat(result.path("configuration").path("documentProfile").asString())
                .isEqualTo("receipt-age-restart-v1");

        var database = directory.resolve("invalid.db");
        var invalid = initialization(database, 1, 0, 0);
        invalid.set("observationTargets", JSON.readTree("""
                [{"viewId":"position","entityId":"bus"},
                 {"viewId":"position","entityId":"bus"}]
                """));
        assertThatThrownBy(() -> call(new TimelineHost(HostProtocol.V2, true), invalid))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Duplicate");
        assertThat(Files.exists(database)).isFalse();
        assertThatThrownBy(() -> call(new TimelineHost(HostProtocol.V2, true),
                initialization(Path.of("relative.db"), 1, 0, 0)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("absolute");
        assertThatThrownBy(() -> call(new TimelineHost(HostProtocol.V2, false),
                initialization(database, 1, 0, 0)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unavailable");
        assertThat(Files.exists(database)).isFalse();
    }

    @Test
    void restartRejectsAMissingDatabaseWithoutCreatingAnEmptyStore() throws Exception {
        var database = directory.resolve("deleted.db");
        var first = new TimelineHost(HostProtocol.V2, true);
        start(first, database, 1, 0, 0);
        call(first, turn("shutdown", 1, 1, 0, 1));
        Files.delete(database);

        assertThatThrownBy(() -> start(new TimelineHost(HostProtocol.V2, true), database, 2, 2, 2))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("existing regular database file");
        assertThat(Files.exists(database)).isFalse();
    }

    @Test
    void aFailedCommitDoesNotAcknowledgeAHostTurnAndCanBeRecovered() throws Exception {
        var database = directory.resolve("commit.db");
        var first = new TimelineHost(HostProtocol.V2, true);
        start(first, database, 1, 0, 0);
        call(first, turn("shutdown", 1, 1, 0, 1));
        execute(database, "CREATE TRIGGER refuse_view BEFORE INSERT ON views "
                + "BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END");

        var failing = new TimelineHost(HostProtocol.V2, true);
        start(failing, database, 2, 2, 2);
        connect(failing, 3, 2, 2, 2);
        assertThatThrownBy(() -> publish(failing, 4, 2, 2, 3))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SQLite storage requires recovery");

        execute(database, "DROP TRIGGER refuse_view");
        var recovered = new TimelineHost(HostProtocol.V2, true);
        start(recovered, database, 3, 4, 4);
        connect(recovered, 5, 3, 4, 4);
        assertThat(receipt(publish(recovered, 6, 3, 4, 4)).path("status").asString())
                .isEqualTo("committed");
        call(recovered, turn("shutdown", 7, 3, 4, 4));
    }

    @Test
    void installedObservationDoesNotDispatchOverdueExpiry() throws Exception {
        var host = new TimelineHost(HostProtocol.V2, true);
        start(host, directory.resolve("read-only.db"), 1, 0, 0);
        connect(host, 1, 1, 0, 0);
        publish(host, 2, 1, 0, 10);
        var observation = turn("observe-installed", 3, 1, 0, 100);
        observation.set("observationTargets", JSON.readTree("""
                [{"viewId":"position","entityId":"bus"}]
                """));
        var result = call(host, observation);
        assertThat(result.path("effects").size()).isZero();
        assertThat(result.path("pendingTasks").intValue()).isOne();
        var snapshot = JSON.readTree(result.path("snapshots").get(0).asString());
        assertThat(snapshot.path("version").longValue()).isOne();
        assertThat(snapshot.path("status").path("fields").path("position")
                .path("freshness").asString()).isEqualTo("fresh");
        call(host, turn("shutdown", 4, 1, 0, 100));
    }

    @Test
    void applyingTheDowntimeOffsetBeforeConstructionMakesRecoveredAgeUnknown() throws Exception {
        var database = directory.resolve("downtime-offset.db");
        var first = new TimelineHost(HostProtocol.V2, true);
        start(first, database, 1, 0, 0);
        connect(first, 1, 1, 0, 0);
        publish(first, 2, 1, 0, 10);
        call(first, turn("shutdown", 3, 1, 0, 11));

        var second = new TimelineHost(HostProtocol.V2, true);
        var recovered = call(second, initialization(database, 2, 4, 21)
                .put("wallOffsetMillis", -15).put("wallMillis", EPOCH + 6));
        var installed = JSON.readTree(recovered.path("snapshots").get(0).asString());
        assertThat(installed.path("version").longValue()).isEqualTo(2);
        var age = installed.path("status").path("fields").path("position");
        assertThat(age.path("freshness").asString()).isEqualTo("ageUnknown");
        assertThat(age.path("receivedAtMillis").isNull()).isTrue();
        assertThat(recovered.path("pendingTasks").intValue()).isZero();
        assertThat(recovered.path("effects").size()).isZero();
        call(second, turn("shutdown", 5, 2, 21, 21).put("wallMillis", EPOCH + 6));
    }

    @Test
    void liveClockSetLeavesCommittedStateAndExistingDeadlineAlone() throws Exception {
        var database = directory.resolve("live-offset.db");
        var host = new TimelineHost(HostProtocol.V2, true);
        start(host, database, 1, 0, 0);
        connect(host, 1, 1, 0, 0);
        publish(host, 2, 1, 0, 10);

        var adjusted = call(host, turn("wall-clock-set", 3, 1, 0, 20)
                .put("wallMillis", EPOCH + 5));
        assertThat(adjusted.path("monotonicMs").longValue()).isEqualTo(20);
        assertThat(adjusted.path("wallMillis").longValue()).isEqualTo(EPOCH + 5);
        assertThat(adjusted.path("effects").size()).isZero();
        assertThat(adjusted.path("pendingTasks").intValue()).isOne();
        assertThat(adjusted.path("heldFrames").intValue()).isZero();
        call(host, turn("shutdown", 4, 1, 0, 21).put("wallMillis", EPOCH + 6));

        // A restart at wall E+36 is above the prior durable high-water mark.
        // No production commit observed the rollback, so retained age stays known.
        var next = new TimelineHost(HostProtocol.V2, true);
        var recovered = call(next, initialization(database, 2, 5, 51)
                .put("wallOffsetMillis", -15).put("wallMillis", EPOCH + 36));
        var installed = JSON.readTree(recovered.path("snapshots").get(0).asString());
        assertThat(installed.path("version").longValue()).isOne();
        var age = installed.path("status").path("fields").path("position");
        assertThat(age.path("freshness").asString()).isEqualTo("fresh");
        assertThat(age.path("receivedAtMillis").longValue()).isEqualTo(EPOCH + 10);
        assertThat(recovered.path("effects").get(0).path("at").longValue()).isEqualTo(75);
        call(next, turn("shutdown", 6, 2, 51, 51).put("wallMillis", EPOCH + 36));
    }

    private static void execute(Path database, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + database);
                var statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static void connect(TimelineHost host, long id, long generation, long start, long at)
            throws Exception {
        call(host, turn("connect", id, generation, start, at)
                .put("session", "feed").put("role", "source"));
    }

    private static JsonNode publish(
            TimelineHost host, long id, long generation, long start, long at) throws Exception {
        return call(host, turn("ingress", id, generation, start, at)
                .put("session", "feed").put("wire", PUBLICATION));
    }

    private static JsonNode receipt(JsonNode response) {
        for (var effect : response.path("effects")) {
            if (effect.path("kind").asString().equals("receipt"))
                return JSON.readTree(effect.path("wire").asString());
        }
        throw new AssertionError("Missing source receipt");
    }

    private static JsonNode start(TimelineHost host, Path database, long generation, long id, long at)
            throws Exception {
        return call(host, initialization(database, generation, id, at));
    }

    private static ObjectNode initialization(Path database, long generation, long id, long at) {
        var command = turn("initialize-document", id, generation, at, at)
                .put("startTimeMs", at).put("epochMillis", EPOCH)
                .put("wire", CONFIGURATION).put("database", database.toString());
        command.set("observationTargets", JSON.readTree("""
                [{"viewId":"position","entityId":"bus"},
                 {"viewId":"position","entityId":"other"}]
                """));
        return command;
    }

    private static ObjectNode turn(String op, long id, long generation, long start, long at) {
        return JSON.createObjectNode().put("op", op).put("turnId", id)
                .put("runtimeGeneration", generation).put("timeMs", at)
                .put("monotonicMs", at - start).put("wallMillis", EPOCH + at);
    }

    private static JsonNode call(TimelineHost host, ObjectNode command) throws Exception {
        return JSON.valueToTree(host.command(command));
    }
}
