package io.zooglass.v2;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

/** Commits a staged image before installing it; any storage failure requires recovery. */
final class SqliteState implements StateStore {

    private final Connection connection;
    private final SqliteStateRows rows;
    private StateImage current;
    private boolean available;

    SqliteState(
            String location,
            V2Configuration configuration,
            java.util.function.UnaryOperator<StateImage> recover) {
        if (location == null || location.isBlank()) {
            throw new IllegalArgumentException("SQLite requires zooglass.v2.database");
        }
        connection = open(location);
        rows = new SqliteStateRows(connection);
        try {
            configure();
            connection.setAutoCommit(false);
            var restored = rows.restore(configuration);
            current = recover.apply(restored);
            if (current != restored) {
                rows.writeChanges(restored, current);
            }
            connection.commit();
            available = true;
        } catch (SQLException | RuntimeException failure) {
            closeAfterFailure(failure);
            throw new IllegalStateException("Cannot restore v2 SQLite state", failure);
        }
    }

    private static Connection open(String location) {
        try {
            Path path = Path.of(location).toAbsolutePath().normalize();
            Path parent = path.getParent().toRealPath();
            path = parent.resolve(path.getFileName());
            if (Files.exists(path)) {
                path = path.toRealPath();
            }
            return DriverManager.getConnection("jdbc:sqlite:" + path.toUri() + "?mode=rwc");
        } catch (java.io.IOException | SQLException failure) {
            throw new IllegalStateException("Cannot open v2 SQLite database", failure);
        }
    }

    private void configure() throws SQLException {
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA busy_timeout=1000");
            // In WAL mode, EXCLUSIVE retains ownership for the connection's lifetime.
            try (var ownership = statement.executeQuery("PRAGMA locking_mode=EXCLUSIVE")) {
                if (!ownership.next() || !"exclusive".equalsIgnoreCase(ownership.getString(1))) {
                    throw new SQLException("Exclusive ownership unavailable");
                }
            }
            try (var mode = statement.executeQuery("PRAGMA journal_mode=WAL")) {
                if (!mode.next() || !"wal".equalsIgnoreCase(mode.getString(1))) {
                    throw new SQLException("WAL mode unavailable");
                }
            }
            statement.execute("PRAGMA synchronous=FULL");
            statement.execute("PRAGMA wal_autocheckpoint=1000");
            statement.execute("PRAGMA journal_size_limit=4194304");
            try (var sync = statement.executeQuery("PRAGMA synchronous")) {
                if (!sync.next() || sync.getInt(1) != 2) {
                    throw new SQLException("FULL synchronisation unavailable");
                }
            }
        }
    }

    @Override
    public StateImage current() {
        if (!available) {
            throw new IllegalStateException("V2 storage requires restart recovery");
        }
        return current;
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
            available = false;
            closeAfterFailure(failure);
            throw new IllegalStateException("V2 storage failed; restart required", failure);
        }
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
            throw new IllegalStateException("Cannot close v2 SQLite database", failure);
        }
    }
}
