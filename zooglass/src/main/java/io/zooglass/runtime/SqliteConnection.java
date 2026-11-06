package io.zooglass.runtime;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

/** Connection setup shared by the runtime and offline tenant adoption. */
final class SqliteConnection {

    private SqliteConnection() {}

    static Connection open(String location) {
        return open(location, "rwc");
    }

    static Connection openExisting(String location) {
        return open(location, "rw");
    }

    private static Connection open(String location, String mode) {
        try {
            Path path = Path.of(location).toAbsolutePath().normalize();
            Path parent = path.getParent().toRealPath();
            path = parent.resolve(path.getFileName());
            if (Files.exists(path)) {
                path = path.toRealPath();
            }
            return DriverManager.getConnection("jdbc:sqlite:" + path.toUri() + "?mode=" + mode);
        } catch (java.io.IOException | SQLException failure) {
            throw new IllegalStateException("Cannot open SQLite database", failure);
        }
    }

    static void configure(Connection connection) throws SQLException {
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
}
