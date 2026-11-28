package io.zooglass.runtime;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.function.UnaryOperator;

/** Static store only. An installed revision check is not a serving or ownership permit. */
final class PostgresState implements StateStore {
    @FunctionalInterface
    interface Connections {
        Connection open() throws SQLException;
    }

    private final Connection db;
    private final HaStaticProfile profile;
    private final String configurationIdentity;
    private final String table;
    private StateImage current;

    PostgresState(HaStaticProfile profile, Connections connections) {
        this.profile = profile;
        this.configurationIdentity = profile.configurationIdentity();
        try {
            db = connections.open();
        } catch (SQLException failure) {
            throw new IllegalStateException("Cannot open PostgreSQL state", failure);
        }
        try {
            db.setAutoCommit(false);
            try (var sql = db.createStatement()) {
                sql.execute("SET synchronous_commit = on");
                sql.execute("SET statement_timeout = '10s'");
                sql.execute("SET lock_timeout = '3s'");
                sql.execute("SET idle_in_transaction_session_timeout = '10s'");
                try (var server = sql.executeQuery(
                        """
                        SELECT pg_catalog.quote_ident(nspname), NOT pg_catalog.pg_is_in_recovery()
                            AND pg_catalog.current_setting('fsync') = 'on'
                        FROM pg_catalog.pg_namespace
                        WHERE nspname = pg_catalog.current_schema()
                          AND oid <> pg_catalog.pg_my_temp_schema()
                          AND NOT pg_catalog.pg_is_other_temp_schema(oid)
                        """)) {
                    if (!server.next() || !server.getBoolean(2)) {
                        throw new SQLException("PostgreSQL requires a persistent schema on a writable durable primary");
                    }
                    // Server-quoted schema from the catalogue, captured once for all subsequent SQL.
                    table = server.getString(1) + ".zooglass_runtime";
                }
                sql.execute("SELECT pg_catalog.pg_advisory_xact_lock(20557, 1)");
            }
            checkOrCreateTable();
            var restored = restore();
            db.commit();
            current = restored;
        } catch (SQLException | RuntimeException failure) {
            abandon(failure);
            throw new IllegalStateException("Cannot restore PostgreSQL state", failure);
        }
    }

    private void checkOrCreateTable() throws SQLException {
        try (var relation = db.prepareStatement("""
                SELECT relkind = 'r' AND relpersistence = 'p' FROM pg_catalog.pg_class
                WHERE oid = pg_catalog.to_regclass(?)
                """)) {
            relation.setString(1, table);
            try (var row = relation.executeQuery()) {
                if (row.next()) {
                    if (!row.getBoolean(1)) throw new SQLException("PostgreSQL requires a permanent runtime table");
                    return;
                }
            }
        }
        initialise();
    }

    private void initialise() throws SQLException {
        try (var sql = db.createStatement()) {
            sql.execute("""
                    CREATE TABLE %s (
                        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                        schema_version INTEGER NOT NULL,
                        profile TEXT NOT NULL,
                        runtime_id BYTEA NOT NULL,
                        tenant BYTEA,
                        configuration TEXT NOT NULL,
                        revision BIGINT NOT NULL CHECK (revision >= 0),
                        image TEXT NOT NULL)
                    """.formatted(table));
        }
        try (var row = db.prepareStatement("""
                INSERT INTO %s
                    (singleton, schema_version, profile, runtime_id, tenant, configuration, revision, image)
                    VALUES (1, 1, ?, ?, ?, ?, 0, ?)
                """.formatted(table))) {
            row.setString(1, HaStaticProfile.NAME);
            row.setBytes(2, bytes(profile.runtimeId()));
            row.setBytes(3, bytes(profile.tenant()));
            row.setString(4, configurationIdentity);
            row.setString(5, PostgresImage.encode(StateImage.empty()));
            row.executeUpdate();
        }
    }

    private StateImage restore() throws SQLException {
        try (var sql = db.createStatement(); var row = sql.executeQuery("""
                SELECT singleton, schema_version, profile, runtime_id, tenant, configuration, revision, image
                FROM %s FOR UPDATE
                """.formatted(table))) {
            if (!row.next() || row.getInt("singleton") != 1 || row.getInt("schema_version") != 1
                    || !HaStaticProfile.NAME.equals(row.getString("profile"))
                    || !Arrays.equals(bytes(profile.runtimeId()), row.getBytes("runtime_id"))
                    || !Arrays.equals(bytes(profile.tenant()), row.getBytes("tenant"))
                    || !configurationIdentity.equals(row.getString("configuration"))) {
                throw new SQLException("Incompatible PostgreSQL runtime binding");
            }
            var restored = PostgresImage.restore(row.getString("image"), row.getLong("revision"), profile.configuration());
            if (row.next()) throw new SQLException("Ambiguous PostgreSQL runtime binding");
            return restored;
        }
    }

    private static byte[] bytes(String value) {
        return value == null ? null : value.getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public StateImage current() {
        if (current == null) throw new StorageUnavailable("PostgreSQL state requires recovery", null);
        return current;
    }

    @Override
    public void install(StateImage next) {
        long expected = current().version();
        try (var update = db.prepareStatement("""
                UPDATE %s SET image = ?, revision = ?
                WHERE singleton = 1 AND revision = ? AND schema_version = 1 AND profile = ?
                  AND runtime_id = ? AND tenant IS NOT DISTINCT FROM ? AND configuration = ?
                """.formatted(table))) {
            if (next.version() != Math.incrementExact(expected)) throw new SQLException("Invalid next revision");
            update.setString(1, PostgresImage.encode(next));
            update.setLong(2, next.version());
            update.setLong(3, expected);
            update.setString(4, HaStaticProfile.NAME);
            update.setBytes(5, bytes(profile.runtimeId()));
            update.setBytes(6, bytes(profile.tenant()));
            update.setString(7, configurationIdentity);
            if (update.executeUpdate() != 1) throw new SQLException("PostgreSQL revision conflict");
            db.commit();
            current = next;
        } catch (SQLException | RuntimeException failure) {
            abandon(failure);
            throw new StorageUnavailable("PostgreSQL commit requires recovery", failure);
        }
    }

    private void abandon(Exception original) {
        current = null;
        try {
            db.rollback();
        } catch (SQLException failure) {
            original.addSuppressed(failure);
        }
        try {
            db.close();
        } catch (SQLException failure) {
            original.addSuppressed(failure);
        }
    }

    @Override
    public void configure(RuntimeConfiguration configuration, UnaryOperator<StateImage> prepare) {
        throw new UnsupportedOperationException("Static HA configuration is immutable");
    }

    @Override
    public boolean durable() {
        return true;
    }

    @Override
    public void close() {
        current = null;
        try {
            db.close();
        } catch (SQLException failure) {
            throw new StorageCloseFailure(failure);
        }
    }
}
