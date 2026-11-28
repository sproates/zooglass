package io.zooglass.runtime;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;

/** Bootstrap and schema identity for the one permanent, namespace-pinned runtime table. */
final class PostgresSchema {
    private final Connection db;
    private final HaStaticProfile profile;
    final String table;

    PostgresSchema(Connection db, HaStaticProfile profile) throws SQLException {
        this.db = db;
        this.profile = profile;
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
    }

    private void checkOrCreateTable() throws SQLException {
        try (var relation = db.prepareStatement("""
                SELECT relkind = 'r' AND relpersistence = 'p' FROM pg_catalog.pg_class
                WHERE oid = pg_catalog.to_regclass(?)
                """)) {
            relation.setString(1, table);
            try (var row = relation.executeQuery()) {
                if (row.next()) {
                    if (!row.getBoolean(1)) throw new java.sql.SQLNonTransientException("PostgreSQL requires a permanent runtime table");
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
                        incarnation UUID NOT NULL,
                        generation BIGINT NOT NULL CHECK (generation >= 0),
                        attempt UUID, role TEXT, lease_until TIMESTAMPTZ,
                        CHECK ((attempt IS NULL AND role IS NULL AND lease_until IS NULL)
                            OR (attempt IS NOT NULL AND role IS NOT NULL
                                AND role IN ('recovering', 'active') AND lease_until IS NOT NULL)),
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
                    (singleton, schema_version, incarnation, generation, profile, runtime_id, tenant, configuration, revision, image)
                    VALUES (1, 2, pg_catalog.gen_random_uuid(), 0, ?, ?, ?, ?, 0, ?)
                """.formatted(table))) {
            row.setString(1, HaStaticProfile.NAME);
            row.setBytes(2, bytes(profile.runtimeId()));
            row.setBytes(3, bytes(profile.tenant()));
            row.setString(4, profile.configurationIdentity());
            row.setString(5, PostgresImage.encode(StateImage.empty()));
            row.executeUpdate();
        }
    }

    static byte[] bytes(String value) {
        return value == null ? null : value.getBytes(StandardCharsets.UTF_8);
    }
}
