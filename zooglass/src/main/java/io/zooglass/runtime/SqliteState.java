package io.zooglass.runtime;

import io.zooglass.logging.OperationalLog;

import java.sql.Connection;
import java.sql.SQLException;

/** Commits a staged image before installing it; any storage failure requires recovery. */
final class SqliteState implements StateStore {

    private final Connection connection;
    private final SqliteStateRows rows;
    private final OperationalLog operations;
    private StateImage current;
    private boolean available;

    SqliteState(
            String location,
            RuntimeConfiguration configuration,
            java.util.function.UnaryOperator<StateImage> recover) {
        this(location, configuration, recover, null);
    }

    SqliteState(
            String location,
            RuntimeConfiguration configuration,
            java.util.function.UnaryOperator<StateImage> recover,
            String tenant) {
        this(location, configuration, recover, tenant, OperationalLog.NONE);
    }

    SqliteState(String location, RuntimeConfiguration configuration,
            java.util.function.UnaryOperator<StateImage> recover, String tenant, OperationalLog operations) {
        this.operations = operations;
        if (tenant != null) {
            StoreTenant.requireTenant(tenant);
        }
        if (location == null || location.isBlank()) {
            throw new IllegalArgumentException("SQLite requires zooglass.database");
        }
        connection = SqliteConnection.open(location);
        rows = new SqliteStateRows(connection);
        try {
            SqliteConnection.configure(connection);
            connection.setAutoCommit(false);
            boolean bind = StoreTenant.check(connection, tenant);
            var restored = rows.restore(configuration);
            if (bind) {
                StoreTenant.bind(connection, tenant);
            }
            current = recover.apply(restored);
            if (current != restored) {
                rows.writeChanges(restored, current);
            }
            connection.commit();
            available = true;
        } catch (SQLException | RuntimeException failure) {
            closeAfterFailure(failure);
            throw new IllegalStateException("Cannot restore SQLite state", failure);
        }
    }

    @Override
    public StateImage current() {
        if (!available) {
            throw new StorageUnavailable("Storage requires restart recovery", null);
        }
        return current;
    }

    @Override
    public void configure(
            RuntimeConfiguration configuration,
            java.util.function.UnaryOperator<StateImage> prepare) {
        current();
        try {
            rows.restore(configuration);
            var prepared = prepare.apply(current);
            rows.writeChanges(current, prepared);
            connection.commit();
            current = prepared;
        } catch (SQLException | RuntimeException failure) {
            throw unavailable(OperationalLog.StoreOperation.REGISTER,
                    "Could not persist view registration; restart required", failure);
        }
    }

    @Override
    public void install(StateImage next) {
        current();
        try {
            rows.writeChanges(current, next);
            connection.commit();
            // The prepared image needs no further allocation or transformation.
            current = next;
        } catch (SQLException | RuntimeException failure) {
            throw unavailable(OperationalLog.StoreOperation.INSTALL, "Storage failed; restart required", failure);
        }
    }

    private StorageUnavailable unavailable(OperationalLog.StoreOperation operation, String message, Exception failure) {
        available = false;
        operations.storageLost(operation);
        closeAfterFailure(failure);
        return new StorageUnavailable(message, failure);
    }

    private void closeAfterFailure(Exception failure) {
        try {
            if (!connection.getAutoCommit()) {
                connection.rollback();
            }
        } catch (SQLException rollbackFailure) {
            failure.addSuppressed(rollbackFailure);
        }
        try {
            connection.close();
        } catch (SQLException closeFailure) {
            failure.addSuppressed(closeFailure);
        }
    }

    @Override
    public boolean durable() {
        return true;
    }

    @Override
    public void close() {
        available = false;
        try {
            connection.close();
        } catch (SQLException failure) {
            throw new StorageCloseFailure(failure);
        }
    }
}
