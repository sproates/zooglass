package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.StaticViewsTestSupport.configuration;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

import io.zooglass.runtime.StaticRecoveryTimelineProfile;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.node.ObjectNode;

class StaticRecoveryStartupTests {
    private static final long EPOCH = FleetTestSupport.EPOCH;

    @TempDir Path directory;

    @Test
    void eligibleInspectionDoesNotAdmitDifferentStartupBytes() throws Exception {
        var config = configuration().put("storage", "sqlite");
        var inspector = new TimelineHost(HostProtocol.V1, false);
        var inspected = JSON.valueToTree(inspector.command(
                StaticViewsTestSupport.inspection(config)
                        .put("profile", StaticRecoveryTimelineProfile.NAME)));
        assertThat(inspected.path("requestedProfile").path("eligible").asBoolean()).isTrue();
        assertThat(inspected.path("effects").isEmpty()).isTrue();
        assertThat(inspected.path("pendingTasks").intValue()).isZero();
        assertThat(inspected.path("heldFrames").intValue()).isZero();

        var database = directory.resolve("changed-configuration.db");
        var command = initialization(config.put("maxStreams", 21), database, 1, 0);
        rejects(command, true, "$.maxStreams");
        assertThat(directory).isEmptyDirectory();
    }

    @Test
    void firstGenerationRefusesAnExistingValidDatabaseWithoutChangingIt() throws Exception {
        var database = createDatabase();
        var before = Files.readAllBytes(database);

        rejects(initialization(configuration().put("storage", "sqlite"), database, 1, 0),
                true, "Static recovery profile requires a new database path in generation 1");

        assertThat(Files.readAllBytes(database)).isEqualTo(before);
    }

    @Test
    void missingRecoveryDatabaseIsNotReplacedWithAnEmptyStore() throws Exception {
        var database = createDatabase();
        Files.delete(database);

        rejects(initialization(configuration().put("storage", "sqlite"), database, 2, 20),
                true, "existing regular database file");

        assertThat(directory).isEmptyDirectory();
    }

    @Test
    void sqliteStartupRequiresNativeSupportBeforeOpeningTheDatabase() throws Exception {
        var command = initialization(configuration().put("storage", "sqlite"),
                directory.resolve("unavailable.db"), 1, 0);

        rejects(command, false, "SQLite lifecycle is unavailable");

        assertThat(directory).isEmptyDirectory();
    }

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void laterGenerationRejectsAClockConsistentButForbiddenWallOffset(String storage) throws Exception {
        var database = storage.equals("sqlite") ? createDatabase() : null;
        var before = database == null ? null : Files.readAllBytes(database);
        var command = initialization(configuration().put("storage", storage), database, 2, 20)
                .put("wallOffsetMillis", 5).put("wallMillis", EPOCH + 25);

        // The envelope satisfies HostTurns: only the requested recovery family forbids this offset.
        rejects(command, storage.equals("sqlite"),
                "Static recovery profile requires initial time zero in generation 1 and no wall adjustment");

        if (database != null) assertThat(Files.readAllBytes(database)).isEqualTo(before);
        else assertThat(directory).isEmptyDirectory();
    }

    private Path createDatabase() throws Exception {
        var database = directory.resolve("runtime.db");
        var command = initialization(configuration().put("storage", "sqlite"), database, 1, 0);
        var host = new TimelineHost(HostProtocol.V2, true);
        try {
            host.command(command);
        } finally {
            host.command(shutdownAfter(command));
        }
        assertThat(database).isRegularFile();
        return database;
    }

    private static void rejects(ObjectNode command, boolean sqliteAvailable, String message)
            throws Exception {
        var host = new TimelineHost(HostProtocol.V2, sqliteAvailable);
        try {
            host.command(command);
        } catch (IllegalArgumentException failure) {
            // Rejected commands poison the host turn. These guards run before composition,
            // so there is no runtime to close and no valid subsequent shutdown command.
            assertThat(failure).hasMessageContaining(message);
            return;
        }
        try {
            fail("Expected startup rejection: " + message);
        } finally {
            // If a guard regresses, close the successfully initialized runtime before failing.
            host.command(shutdownAfter(command));
        }
    }

    private static ObjectNode initialization(
            ObjectNode config, Path database, long generation, long atMs) {
        var command = JSON.createObjectNode().put("op", "initialize-document")
                .put("turnId", 0).put("runtimeGeneration", generation)
                .put("timeMs", atMs).put("startTimeMs", atMs).put("monotonicMs", 0)
                .put("epochMillis", EPOCH).put("wallMillis", EPOCH + atMs)
                .put("profile", StaticRecoveryTimelineProfile.NAME).put("wire", config.toString());
        if (database != null) command.put("database", database.toString());
        return command;
    }

    private static ObjectNode shutdownAfter(ObjectNode command) {
        return JSON.createObjectNode().put("op", "shutdown")
                .put("turnId", 1).put("runtimeGeneration", command.path("runtimeGeneration").longValue())
                .put("timeMs", command.path("timeMs").longValue()).put("monotonicMs", 0)
                .put("wallMillis", command.path("wallMillis").longValue());
    }
}
