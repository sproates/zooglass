package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.ZooGlassApplication;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.function.UnaryOperator;

class StoreTenantTests {

    @TempDir Path directory;

    @Test
    void ownershipSurvivesRestartAndBackup() throws Exception {
        Path database = directory.resolve("a.sqlite");
        try (var store = open(database, "tenant-a")) {
            assertThat(store.current().version()).isZero();
        }
        Path backup = directory.resolve("restored.sqlite");
        Files.copy(database, backup);
        assertThatThrownBy(() -> open(backup, "tenant-b"))
                .hasRootCauseMessage("Database tenant does not match the configured tenant");
        assertThatThrownBy(() -> open(backup, null))
                .hasRootCauseMessage("Open demo mode cannot open a tenant-bound store");
        try (var restored = open(backup, "tenant-a")) {
            assertThat(restored.current().version()).isZero();
        }
        assertThat(schema(backup)).isEqualTo(7);
    }

    @Test
    void existingDataRequiresAdoptionAndKeepsItsViewsAndReceipts() throws Exception {
        Path database = populated("legacy.sqlite");
        assertThatThrownBy(() -> open(database, "tenant-a"))
                .hasRootCauseMessage("Existing unowned database requires offline adopt-store");
        assertThat(schema(database)).isEqualTo(4);

        StoreAdoption.adopt(database, "tenant-a");
        StoreAdoption.adopt(database, "tenant-a");
        assertThatThrownBy(() -> StoreAdoption.adopt(database, "tenant-b"))
                .hasRootCauseMessage("Database tenant does not match the configured tenant");
        try (var restored = open(database, "tenant-a")) {
            assertThat(restored.current().version()).isEqualTo(1);
            assertThat(restored.current().views()).containsKey(new StateImage.ViewEntity("latest", "car"));
            assertThat(restored.current().streams().values().iterator().next().receipts()).containsKey(1L);
        }
        Path other = populated("b.sqlite");
        StoreAdoption.adopt(other, "tenant-b");
        assertThatThrownBy(() -> open(database, "tenant-b"))
                .hasRootCauseMessage("Database tenant does not match the configured tenant");
        assertThat(schema(database)).isEqualTo(7);
    }

    @Test
    void initialisedButUnusedLegacyStoreRequiresExplicitAdoption() {
        Path database = directory.resolve("empty.sqlite");
        try (var ignored = open(database, null)) {}
        assertThatThrownBy(() -> open(database, "tenant-a"))
                .hasRootCauseMessage("Existing unowned database requires offline adopt-store");
        StoreAdoption.adopt(database, "tenant-a");
        try (var restored = open(database, "tenant-a")) {
            assertThat(restored.current().version()).isZero();
        }
    }

    @Test
    void adoptionCannotRunWhileTheServiceOwnsTheDatabase() {
        Path database = directory.resolve("busy.sqlite");
        try (var service = new ViewCoordinator(SqliteRecoveryTests.configuration(), database.toString())) {
            service.apply(IdentityFixtures.event(1));
            assertThatThrownBy(() -> StoreAdoption.adopt(database, "tenant-a"))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(service.apply(IdentityFixtures.event(2)).status()).isEqualTo("committed");
        }
        try (var restored = open(database, null)) {
            assertThat(restored.current().version()).isEqualTo(2);
        }
    }

    @Test
    void failedRecoveryDoesNotBindOrMigrateTheStore() throws Exception {
        Path database = populated("invalid.sqlite");
        sql(database, "UPDATE views SET state='{}'");
        assertThatThrownBy(() -> StoreAdoption.adopt(database, "tenant-a"))
                .isInstanceOf(RuntimeException.class);
        assertThat(schema(database)).isEqualTo(4);
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + database);
                var statement = connection.createStatement();
                var row = statement.executeQuery("SELECT count(*) FROM sqlite_schema WHERE name='store_tenant'")) {
            assertThat(row.next()).isTrue();
            assertThat(row.getInt(1)).isZero();
        }
    }

    @Test
    void damagedOwnershipAndDowngradedMarkersFailClosed() throws Exception {
        Path database = directory.resolve("damaged.sqlite");
        try (var ignored = open(database, "tenant-a")) {}
        sql(database, "PRAGMA user_version=4");
        assertThatThrownBy(() -> open(database, null))
                .hasRootCauseMessage("Invalid tenant ownership schema marker");
        sql(database, "PRAGMA user_version=7");
        sql(database, "DELETE FROM store_tenant");
        assertThatThrownBy(() -> open(database, "tenant-a"))
                .hasRootCauseMessage("Missing tenant ownership");
    }

    @Test
    void recoveryFailureRollsBackNewOwnershipAndSchemaTogether() throws Exception {
        Path database = directory.resolve("fresh.sqlite");
        assertThatThrownBy(() -> new SqliteState(database.toString(), SqliteRecoveryTests.configuration(),
                image -> { throw new IllegalStateException("recovery failed"); }, "tenant-a"))
                .hasRootCauseMessage("recovery failed");
        assertThat(schema(database)).isZero();
        try (var store = open(database, "tenant-b")) {
            assertThat(store.current().version()).isZero();
        }
    }

    @Test
    void adoptionRejectsMissingForeignAndInvalidInputs() throws Exception {
        Path absent = directory.resolve("absent.sqlite");
        assertThatThrownBy(() -> StoreAdoption.adopt(absent, "tenant-a"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(Files.exists(absent)).isFalse();
        Path foreign = directory.resolve("foreign.sqlite");
        sql(foreign, "CREATE TABLE unrelated(value TEXT)");
        assertThatThrownBy(() -> StoreAdoption.adopt(foreign, "tenant-a"))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> open(foreign, "tenant-a"))
                .hasRootCauseMessage("Existing unowned database requires offline adopt-store");
        for (String tenant : new String[] {"", " ", " tenant-a"}) {
            assertThatThrownBy(() -> StoreAdoption.adopt(foreign, tenant))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> StoreAdoption.run(new String[] {"adopt-store"}))
                .hasMessageContaining("Usage:");
    }

    @Test
    void adoptionCommandDoesNotStartTheServerAndStartupRejectsItsStore() throws Exception {
        Path database = populated("command.sqlite");
        ZooGlassApplication.main(
                new String[] {"adopt-store", database.toString(), "tenant-a"});
        Path config = directory.resolve("views.json");
        Files.writeString(config, new JsonMapper()
                .writeValueAsString(SqliteRecoveryTests.configuration()));
        new ApplicationContextRunner()
                .withBean(ViewCoordinator.class)
                .withPropertyValues("zooglass.config=" + config.toUri(),
                        "zooglass.database=" + database)
                .run(context -> assertThat(context.getStartupFailure())
                        .hasRootCauseMessage("Open demo mode cannot open a tenant-bound store"));
    }

    @Test
    void ownedStoreRetainsItsMarkerAcrossDataSchemaUpgrade() throws Exception {
        Path database = directory.resolve("upgrade.sqlite");
        var original = ProgressTests.configuration("sqlite");
        try (var store = new SqliteState(database.toString(), original,
                UnaryOperator.identity(), "tenant-a")) {
            assertThat(store.current().version()).isZero();
        }
        var views = new ArrayList<>(original.views());
        views.add(ReceiptAgeTests.config("sqlite", 5000).views().getFirst());
        var upgraded = new RuntimeConfiguration(2, "sqlite", original.maxStreams(),
                original.identityWindow(), original.maxHistoryEntries(), original.sources(), views);
        try (var store = new SqliteState(database.toString(), upgraded,
                UnaryOperator.identity(), "tenant-a")) {
            assertThat(store.current().version()).isZero();
        }
        assertThat(schema(database)).isEqualTo(7);
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + database)) {
            assertThat(StoreTenant.dataSchema(connection)).isEqualTo(5);
        }
        StoreAdoption.adopt(database, "tenant-a");
    }

    @Test
    void factStoreCanBeAdoptedWithoutChangingItsDataSchema() throws Exception {
        Path database = directory.resolve("facts.sqlite");
        var config = FactFixtures.configuration("sqlite", 10, false);
        try (var ignored = new ViewCoordinator(config, database.toString())) {}
        StoreAdoption.adopt(database, "tenant-a");
        try (var store = new SqliteState(database.toString(), config,
                UnaryOperator.identity(), "tenant-a")) {
            assertThat(store.current().version()).isZero();
        }
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + database)) {
            assertThat(StoreTenant.dataSchema(connection)).isEqualTo(6);
        }
    }

    private Path populated(String name) {
        Path database = directory.resolve(name);
        try (var service = new ViewCoordinator(SqliteRecoveryTests.configuration(), database.toString())) {
            assertThat(service.apply(IdentityFixtures.event(1)).status()).isEqualTo("committed");
        }
        return database;
    }

    private SqliteState open(Path database, String tenant) {
        return new SqliteState(database.toString(), SqliteRecoveryTests.configuration(),
                UnaryOperator.identity(), tenant);
    }

    private int schema(Path database) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + database)) {
            return StoreTenant.schema(connection);
        }
    }

    private void sql(Path database, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + database);
                var statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
