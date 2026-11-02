package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;
import java.util.Map;

import static io.zooglass.v2.IdentityFixtures.event;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SqliteFailureTests {
    @TempDir
    Path directory;

    @Test
    void failureAfterWritingIdentityRollsBackAllRowsAndStopsServing() throws Exception {
        Path file = directory.resolve("state.sqlite");
        var config = SqliteRecoveryTests.configuration();
        try (var first = new ViewCoordinator(config, file.toString())) {
            first.apply(event(1));
        }
        execute(file, """
                CREATE TRIGGER refuse_view BEFORE INSERT ON views
                BEGIN SELECT RAISE(ABORT, 'injected write failure'); END
                """);
        try (var failing = new ViewCoordinator(config, file.toString())) {
            assertThatThrownBy(() -> failing.apply(event(2))).isInstanceOf(IllegalStateException.class);
            assertThat(failing.healthy()).isFalse();
            assertThat(new V2StorageHealth(failing).health().getStatus().getCode()).isEqualTo("DOWN");
            assertThatThrownBy(() -> failing.snapshot("latest", "car"))
                    .isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> failing.apply(event(1))).isInstanceOf(IllegalStateException.class);
        }

        execute(file, "DROP TRIGGER refuse_view");
        try (var recovered = new ViewCoordinator(config, file.toString())) {
            assertThat(recovered.snapshot("latest", "car").orElseThrow().version()).isEqualTo(1);
            assertThat(recovered.apply(event(1)).reason()).isEqualTo("alreadyCommitted");
            assertThat(recovered.apply(event(2)).status()).isEqualTo("committed");
            assertThat(recovered.snapshot("history", "car").orElseThrow().data().get("position")).hasSize(2);
        }
    }

    @Test
    void incompatibleDefinitionsAndLimitsFailWithoutChangingStoredState() {
        Path file = directory.resolve("state.sqlite");
        var initial = SqliteRecoveryTests.configuration();
        try (var first = new ViewCoordinator(initial, file.toString())) {
            first.apply(event(1));
        }
        var changedViews = List.of(new V2Configuration.View("latest", Map.of(
                "position", new V2Configuration.Field("fleet", "position", "arrival"))));
        for (var changed : List.of(
                new V2Configuration(2, "sqlite", 5, 4, 5, initial.sources(), initial.views()),
                new V2Configuration(2, "sqlite", 5, 3, 5, initial.sources(), changedViews),
                new V2Configuration(2, "sqlite", 5, 3, 5,
                        List.of(new V2Configuration.Source("fleet", "trip-2")), initial.views()))) {
            assertThatThrownBy(() -> new ViewCoordinator(changed, file.toString()))
                    .isInstanceOf(IllegalStateException.class);
        }
        try (var recovered = new ViewCoordinator(initial, file.toString())) {
            assertThat(recovered.apply(event(1)).status()).isEqualTo("duplicate");
        }
    }

    @Test
    void refusesMissingLocationsForeignSchemasAndCorruptState() throws Exception {
        var config = SqliteRecoveryTests.configuration();
        assertThatThrownBy(() -> new ViewCoordinator(config)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ViewCoordinator(config, directory.resolve("absent/state.sqlite").toString()))
                .isInstanceOf(IllegalStateException.class);
        Path foreign = directory.resolve("foreign.sqlite");
        execute(foreign, "CREATE TABLE unrelated(value TEXT)");
        assertThatThrownBy(() -> new ViewCoordinator(config, foreign.toString()))
                .isInstanceOf(IllegalStateException.class);

        Path damaged = directory.resolve("damaged.sqlite");
        Files.writeString(damaged, "not a database");
        assertThatThrownBy(() -> new ViewCoordinator(config, damaged.toString()))
                .isInstanceOf(IllegalStateException.class);
        for (String damage : List.of(
                "PRAGMA user_version=999",
                "DELETE FROM runtime",
                "UPDATE streams SET state='{}'",
                "UPDATE runtime SET version=0",
                "UPDATE streams SET epoch='unknown'",
                "UPDATE streams SET state=json_set(state, '$.floor', 0)",
                "UPDATE streams SET state=json_set(state, '$.receipts', json('{}'))",
                "UPDATE streams SET state=json_set(state, '$.receipts.1.version', 99)",
                "UPDATE streams SET state=json_set(state, '$.receipts.1.version', 1.5)",
                "UPDATE streams SET state=json_set(state, '$.receipts.1.content', json('[]'))",
                "UPDATE views SET state=json_set(state, '$.data.position', json('[]')) WHERE view='latest'",
                "UPDATE views SET state=json_set(state, '$.data.position', json('{}')) WHERE view='history'",
                "UPDATE views SET state=json_set(state, '$.data.position.publicationSequence', 0) WHERE view='latest'",
                "UPDATE views SET state='{\"version\":1,\"data\":{\"unexpected\":{}}}'")) {
            Path file = directory.resolve("test-" + Math.abs(damage.hashCode()) + ".sqlite");
            try (var initial = new ViewCoordinator(config, file.toString())) {
                initial.apply(event(1));
            }
            execute(file, damage);
            assertThatThrownBy(() -> new ViewCoordinator(config, file.toString()))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    private void execute(Path file, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file.toUri());
                var statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
