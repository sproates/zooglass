package io.zooglass.runtime;

import static io.zooglass.runtime.ProgressFailureTests.execute;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;
import java.util.Map;

class ProgressMigrationTests {

    @TempDir Path directory;

    @Test
    void literalSchemaThreeRetainsValuesIdentitiesAndUnknownHistoricalFieldOutcomes()
            throws Exception {
        Path file = directory.resolve("old.db");
        createSchemaThree(file);
        try (var runtime = new ViewCoordinator(configuration(), file.toString())) {
            var before = runtime.snapshot("latest", "car").orElseThrow();
            assertThat(before.version()).isEqualTo(7);
            assertThat(before.status().inputs().get("fleet").completeness()).isEqualTo("unknown");
            assertThat(runtime.advance(new ProgressControl("fleet", "v1", "car", 40)).reason())
                    .isEqualTo("progressUntracked");
            var retry =
                    runtime.apply(
                            IdentityFixtures.parse("fleet", "v1", "car", 40, "position", "{}"));
            assertThat(retry.version()).isEqualTo(7);
            assertThat(retry.targets().getFirst().fields()).isNull();
            assertThat(
                            runtime.apply(
                                            IdentityFixtures.parse(
                                                    "fleet", "v1", "car", 39, "position", "{}"))
                                    .reason())
                    .isEqualTo("outsideRetention");
            assertThat(
                            runtime.apply(
                                            IdentityFixtures.parse(
                                                    "fleet", "v1", "car", 41, "position", "{}"))
                                    .targets()
                                    .getFirst()
                                    .fields())
                    .hasSize(1);
        }
        assertThat(query(file, "PRAGMA user_version")).isEqualTo("4");
        try (var runtime = new ViewCoordinator(configuration(), file.toString())) {
            assertThat(runtime.snapshot("latest", "car").orElseThrow().version()).isEqualTo(8);
        }
    }

    @Test
    void schemaThreeMigrationFailureRollsBackRowsConfigurationAndVersion() throws Exception {
        Path file = directory.resolve("old.db");
        createSchemaThree(file);
        String before = query(file, "SELECT state FROM streams");
        execute(
                file,
                "CREATE TRIGGER refuse_migration BEFORE INSERT ON streams BEGIN SELECT"
                        + " RAISE(ABORT,'test'); END");
        assertThatThrownBy(() -> new ViewCoordinator(configuration(), file.toString()))
                .isInstanceOf(IllegalStateException.class);
        assertThat(query(file, "PRAGMA user_version")).isEqualTo("3");
        assertThat(query(file, "SELECT state FROM streams")).isEqualTo(before);
        execute(file, "DROP TRIGGER refuse_migration");
        try (var runtime = new ViewCoordinator(configuration(), file.toString())) {
            assertThat(runtime.snapshot("latest", "car").orElseThrow().version()).isEqualTo(7);
        }
    }

    private static RuntimeConfiguration configuration() {
        return new RuntimeConfiguration(
                2,
                "sqlite",
                5,
                3,
                5,
                List.of(new RuntimeConfiguration.Source("fleet", "v1")),
                List.of(
                        new RuntimeConfiguration.View(
                                "latest",
                                Map.of(
                                        "position",
                                        new RuntimeConfiguration.Field(
                                                "fleet", "position", "latestBySequence")))));
    }

    private static void createSchemaThree(Path file) throws Exception {
        execute(
                file,
                "CREATE TABLE runtime(id INTEGER PRIMARY KEY, version INTEGER NOT NULL,"
                        + " configuration TEXT NOT NULL)");
        execute(
                file,
                "CREATE TABLE streams(source TEXT, epoch TEXT, entity TEXT, state TEXT, PRIMARY"
                        + " KEY(source,epoch,entity))");
        execute(
                file,
                "CREATE TABLE views(view TEXT, entity TEXT, state TEXT, PRIMARY KEY(view,entity))");
        execute(file, "PRAGMA user_version=3");
        execute(
                file,
                """
                INSERT INTO runtime VALUES(1,7,'{"contractVersion":2,"storage":"sqlite","maxStreams":5,
                "identityWindow":3,"maxHistoryEntries":5,"sources":[{"id":"fleet","epoch":"v1"}],
                "views":[{"id":"latest","fields":{"position":{"sourceId":"fleet","type":"position","mode":"latestBySequence"}}}]}')
                """);
        execute(
                file,
                """
                INSERT INTO streams VALUES('fleet','v1','car','{"floor":40,"receipts":{"40":{"type":"position","content":{},"version":7,
                "targets":[{"viewId":"latest","entityId":"car","status":"accepted","reason":null,"changedFields":["position"]}]}}}')
                """);
        execute(
                file,
                """
                INSERT INTO views VALUES('latest','car','{"version":7,"data":{"position":{"publicationSequence":40,"payload":{}}},
                "provenance":{"position":{"sourceId":"fleet","epoch":"v1","sourceEntityId":"car"}},
                "candidates":{"position":{"fleet":{"value":{"publicationSequence":40,"payload":{}},
                "provenance":{"sourceId":"fleet","epoch":"v1","sourceEntityId":"car"}}}}}')
                """);
    }

    private static String query(Path file, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file);
                var statement = connection.createStatement();
                var rows = statement.executeQuery(sql)) {
            assertThat(rows.next()).isTrue();
            return rows.getString(1);
        }
    }
}
