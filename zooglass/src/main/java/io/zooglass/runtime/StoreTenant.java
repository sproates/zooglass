package io.zooglass.runtime;

import java.sql.Connection;
import java.sql.SQLException;

/** Ownership checks run inside the store's exclusive startup transaction, before recovery. */
final class StoreTenant {

    // Old binaries reject this version rather than opening a protected store as a demo.
    static final int OWNED_SCHEMA = 7;

    private StoreTenant() {}

    static void requireTenant(String tenant) {
        if (tenant == null || tenant.isBlank() || !tenant.equals(tenant.strip())) {
            throw new IllegalArgumentException("A nonblank tenant ID without outer whitespace is required");
        }
    }

    /** Returns true only when an empty store needs binding after its schema is created. */
    static boolean check(Connection connection, String tenant) throws SQLException {
        int schema = schema(connection);
        if (schema == OWNED_SCHEMA) {
            String owner = owner(connection);
            if (tenant == null) {
                throw new SQLException("Open demo mode cannot open a tenant-bound store");
            }
            if (!tenant.equals(owner)) {
                throw new SQLException("Database tenant does not match the configured tenant");
            }
            dataSchema(connection);
            return false;
        }
        if (hasOwnershipTable(connection)) {
            throw new SQLException("Invalid tenant ownership schema marker");
        }
        if (tenant == null) {
            return false;
        }
        if (schema != 0 || hasTables(connection)) {
            throw new SQLException("Existing unowned database requires offline adopt-store");
        }
        return true;
    }

    static int schema(Connection connection) throws SQLException {
        try (var statement = connection.createStatement();
                var row = statement.executeQuery("PRAGMA user_version")) {
            row.next();
            return row.getInt(1);
        }
    }

    private static boolean hasTables(Connection connection) throws SQLException {
        try (var statement = connection.createStatement();
                var row = statement.executeQuery(
                        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
            return row.next();
        }
    }

    private static boolean hasOwnershipTable(Connection connection) throws SQLException {
        try (var statement = connection.createStatement();
                var row = statement.executeQuery(
                        "SELECT 1 FROM sqlite_schema WHERE name='store_tenant'")) {
            return row.next();
        }
    }

    private static String owner(Connection connection) throws SQLException {
        try (var statement = connection.createStatement();
                var rows = statement.executeQuery("SELECT id, tenant FROM store_tenant")) {
            if (!rows.next() || rows.getInt(1) != 1) {
                throw new SQLException("Missing tenant ownership");
            }
            String tenant = rows.getString(2);
            requireTenant(tenant);
            if (rows.next()) {
                throw new SQLException("Ambiguous tenant ownership");
            }
            return tenant;
        }
    }

    static int dataSchema(Connection connection) throws SQLException {
        try (var statement = connection.createStatement();
                var row = statement.executeQuery("SELECT data_schema FROM store_tenant WHERE id=1")) {
            if (!row.next()) {
                throw new SQLException("Missing tenant ownership");
            }
            int schema = row.getInt(1);
            if (schema < 4 || schema > 6) {
                throw new SQLException("Unsupported owned data schema");
            }
            return schema;
        }
    }

    static void bind(Connection connection, String tenant) throws SQLException {
        requireTenant(tenant);
        int dataSchema = schema(connection);
        if (dataSchema < 4 || dataSchema > 6) {
            throw new SQLException("Recover the database before binding its tenant");
        }
        try (var statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE store_tenant(
                        id INTEGER PRIMARY KEY CHECK(id=1),
                        tenant TEXT NOT NULL CHECK(length(tenant)>0),
                        data_schema INTEGER NOT NULL CHECK(data_schema BETWEEN 4 AND 6))
                    """);
        }
        try (var insert = connection.prepareStatement(
                "INSERT INTO store_tenant(id, tenant, data_schema) VALUES(1, ?, ?)")) {
            insert.setString(1, tenant);
            insert.setInt(2, dataSchema);
            insert.executeUpdate();
        }
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA user_version=" + OWNED_SCHEMA);
        }
    }

    static void setSchema(Connection connection, int version) throws SQLException {
        if (schema(connection) == OWNED_SCHEMA) {
            try (var update = connection.prepareStatement(
                    "UPDATE store_tenant SET data_schema=? WHERE id=1")) {
                update.setInt(1, version);
                if (update.executeUpdate() != 1) {
                    throw new SQLException("Missing tenant ownership");
                }
            }
        } else {
            try (var statement = connection.createStatement()) {
                statement.execute("PRAGMA user_version=" + version);
            }
        }
    }
}
