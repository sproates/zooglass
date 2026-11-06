package io.zooglass.runtime;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;

/** Offline command: validates the existing state and binds an unowned store in one transaction. */
public final class StoreAdoption {

    private StoreAdoption() {}

    public static void run(String[] args) {
        if (args.length != 3 || !"adopt-store".equals(args[0])) {
            throw new IllegalArgumentException("Usage: adopt-store /absolute/path/database tenant-id");
        }
        adopt(Path.of(args[1]), args[2]);
    }

    public static void adopt(Path database, String tenant) {
        StoreTenant.requireTenant(tenant);
        if (!Files.isRegularFile(database)) {
            throw new IllegalArgumentException("Adoption requires an existing database file");
        }
        try (var connection = SqliteConnection.openExisting(database.toString())) {
            SqliteConnection.configure(connection);
            connection.setAutoCommit(false);
            try {
                boolean alreadyOwned = StoreTenant.schema(connection) == StoreTenant.OWNED_SCHEMA;
                // Also rejects a conflicting owner or a damaged ownership marker.
                StoreTenant.check(connection, alreadyOwned ? tenant : null);
                var rows = new SqliteStateRows(connection);
                var configuration = rows.storedConfiguration();
                configuration.validate();
                rows.restore(configuration);
                if (!alreadyOwned) {
                    StoreTenant.bind(connection, tenant);
                }
                connection.commit();
            } catch (SQLException | RuntimeException failure) {
                try {
                    connection.rollback();
                } catch (SQLException rollbackFailure) {
                    failure.addSuppressed(rollbackFailure);
                }
                throw failure;
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Cannot adopt database; no ownership change committed", failure);
        }
    }
}
