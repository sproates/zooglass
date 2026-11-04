package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;

import static io.zooglass.v2.IdentityFixtures.event;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class EntityMigrationTests {
    @TempDir
    Path directory;

    @Test
    void schemaOneMigratesWithoutInventingHistoricalTargetsOrChangingValuesAndVersions() throws Exception {
        Path file = directory.resolve("old.db");
        createSchemaOne(file);
        try (var runtime = new ViewCoordinator(SqliteRecoveryTests.configuration(), file.toString())) {
            var snapshot = runtime.snapshot("latest", "car").orElseThrow();
            assertThat(snapshot.version()).isEqualTo(7);
            assertThat(snapshot.data().get("position").at("/payload/value").intValue()).isEqualTo(40);
            assertThat(snapshot.provenance()).containsEntry("position", new Provenance("fleet", "trip-1", "car"));
            var retry = runtime.apply(event(40));
            assertThat(retry.status()).isEqualTo("duplicate");
            assertThat(retry.version()).isEqualTo(7);
            assertThat(retry.targets()).isNull();
            assertThat(runtime.apply(event(39)).reason()).isEqualTo("outsideRetention");
            assertThat(runtime.apply(event(41)).version()).isEqualTo(8);
        }
        assertThat(query(file, "PRAGMA user_version")).isEqualTo("3");
        try (var runtime = new ViewCoordinator(SqliteRecoveryTests.configuration(), file.toString())) {
            assertThat(runtime.apply(event(40)).targets()).isNull();
            assertThat(runtime.apply(event(41)).targets()).hasSize(3);
            assertThat(runtime.snapshot("latest", "car").orElseThrow().version()).isEqualTo(8);
        }
    }

    @Test
    void schemaTwoSeedsCandidatesAndPreservesRecordedTargets() throws Exception {
        Path file = directory.resolve("schema-two.db");
        createSchemaOne(file);
        execute(file, "PRAGMA user_version=2");
        execute(file, """
                UPDATE views SET state=json_set(state,'$.provenance',
                json('{"position":{"sourceId":"fleet","epoch":"trip-1","sourceEntityId":"car"}}'))
                """);
        execute(file, """
                UPDATE streams SET state=json_set(state,'$.receipts.40.targets',
                json('[{"viewId":"latest","entityId":"car","status":"accepted","reason":null,"changedFields":["position"]}]'))
                """);
        try (var runtime = new ViewCoordinator(SqliteRecoveryTests.configuration(), file.toString())) {
            assertThat(runtime.snapshot("latest", "car").orElseThrow().version()).isEqualTo(7);
            assertThat(runtime.apply(event(40)).targets()).containsExactly(
                    new TargetOutcome("latest", "car", "accepted", null, List.of("position")));
        }
        assertThat(query(file, "PRAGMA user_version")).isEqualTo("3");
        assertThat(query(file, "SELECT json_extract(state,'$.candidates.position.fleet.value.publicationSequence') FROM views"))
                .isEqualTo("40");
    }

    @Test
    void migrationFailureRollsBackMetadataRowsAndSchemaMarker() throws Exception {
        Path file = directory.resolve("old.db");
        createSchemaOne(file);
        String metadata = query(file, "SELECT configuration FROM runtime");
        String view = query(file, "SELECT state FROM views");
        execute(file, "CREATE TRIGGER refuse_migration BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'test'); END");
        assertThatThrownBy(() -> new ViewCoordinator(SqliteRecoveryTests.configuration(), file.toString()))
                .isInstanceOf(IllegalStateException.class);
        assertThat(query(file, "PRAGMA user_version")).isEqualTo("1");
        assertThat(query(file, "SELECT configuration FROM runtime")).isEqualTo(metadata);
        assertThat(query(file, "SELECT state FROM views")).isEqualTo(view);
        execute(file, "DROP TRIGGER refuse_migration");
        try (var recovered = new ViewCoordinator(SqliteRecoveryTests.configuration(), file.toString())) {
            assertThat(recovered.apply(event(40)).targets()).isNull();
        }
    }

    @Test
    void mappingWriteFailureRollsBackReceiptTargetsProvenanceAndValues() throws Exception {
        Path file = directory.resolve("mapped.db");
        var config = EntityMappingTests.configuration("sqlite");
        PublicationOutcome original;
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            original = runtime.apply(EntityMappingTests.payment("payment-9", 1));
        }
        execute(file, "CREATE TRIGGER refuse_view BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'test'); END");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            assertThatThrownBy(() -> runtime.apply(EntityMappingTests.payment("payment-9", 2)))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(runtime.healthy()).isFalse();
        }
        execute(file, "DROP TRIGGER refuse_view");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            assertThat(runtime.apply(EntityMappingTests.payment("payment-9", 1)).targets()).isEqualTo(original.targets());
            assertThat(runtime.snapshot("summary", "order-42").orElseThrow().version()).isEqualTo(1);
            assertThat(runtime.apply(EntityMappingTests.payment("payment-9", 2)).status()).isEqualTo("committed");
        }
    }

    @Test
    void recoveryRejectsTamperedProvenanceAndTargetOutcomes() throws Exception {
        int index = 0;
        for (String damage : List.of(
                "UPDATE views SET state=json_remove(state,'$.provenance')",
                "UPDATE views SET state=json_set(state,'$.provenance.payment.sourceEntityId','other')",
                "UPDATE views SET state=json_set(state,'$.provenance.payment.epoch','other')",
                "UPDATE streams SET state=json_set(state,'$.receipts.1.targets[0].entityId','other')",
                "UPDATE streams SET state=json_set(state,'$.receipts.1.targets[0].status','rejected')",
                "UPDATE streams SET state=json_set(state,'$.receipts.1.targets[0].changedFields',json('[\"stock\"]'))")) {
            Path file = directory.resolve("corrupt-" + index++ + ".db");
            var config = EntityMappingTests.configuration("sqlite");
            try (var runtime = new ViewCoordinator(config, file.toString())) {
                runtime.apply(EntityMappingTests.payment("payment-9", 1));
            }
            execute(file, damage);
            assertThatThrownBy(() -> new ViewCoordinator(config, file.toString()), damage)
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    /** Independent literal schema-1 fixture, not a database generated by the new writer. */
    private void createSchemaOne(Path file) throws Exception {
        execute(file, "CREATE TABLE runtime(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, configuration TEXT NOT NULL)");
        execute(file, "CREATE TABLE streams(source TEXT, epoch TEXT, entity TEXT, state TEXT, PRIMARY KEY(source,epoch,entity))");
        execute(file, "CREATE TABLE views(view TEXT, entity TEXT, state TEXT, PRIMARY KEY(view,entity))");
        execute(file, "PRAGMA user_version=1");
        execute(file, """
                INSERT INTO runtime VALUES(1,7,'{"contractVersion":2,"storage":"sqlite","maxStreams":5,
                "identityWindow":3,"maxHistoryEntries":5,
                "sources":[{"id":"fleet","epoch":"trip-1"},{"id":"backup","epoch":"trip-1"}],
                "views":[{"id":"latest","fields":{"position":{"sourceId":"fleet","type":"position","mode":"latestBySequence"}}},
                {"id":"history","fields":{"position":{"sourceId":"fleet","type":"position","mode":"historyBySequence"}}},
                {"id":"arrival","fields":{"position":{"sourceId":"fleet","type":"position","mode":"arrival"}}}]}')
                """);
        execute(file, """
                INSERT INTO streams VALUES('fleet','trip-1','car',
                '{"floor":40,"receipts":{"40":{"type":"position","content":{"value":40},"version":7}}}')
                """);
        execute(file, """
                INSERT INTO views VALUES('latest','car',
                '{"version":7,"data":{"position":{"publicationSequence":40,"payload":{"value":40}}}}')
                """);
    }

    private static void execute(Path file, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file);
                var statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static String query(Path file, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file);
                var statement = connection.createStatement();
                var result = statement.executeQuery(sql)) {
            assertThat(result.next()).isTrue();
            return result.getString(1);
        }
    }
}
