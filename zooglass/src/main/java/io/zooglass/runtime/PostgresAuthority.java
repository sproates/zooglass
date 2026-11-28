package io.zooglass.runtime;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.UUID;

/** All operations run inside the caller's transaction on the same locked authority/image row. */
final class PostgresAuthority {
    record Identity(UUID incarnation, UUID attempt, long generation) {}
    private record Row(UUID incarnation, UUID attempt, long generation, String role, long revision,
            OffsetDateTime until, OffsetDateTime now) {
        boolean leased() { return until != null && until.isAfter(now); }
    }

    private final Connection db;
    private final String table;
    private final HaStaticProfile profile;
    private final String config;
    private final long leaseMillis;
    private final Identity identity;

    static long leaseMillis(Duration lease) {
        long value = lease.toMillis();
        if (value < 1 || value > 300_000 || !Duration.ofMillis(value).equals(lease)) {
            throw new IllegalArgumentException("Lease must be between 1 and 300000 whole milliseconds");
        }
        return value;
    }

    PostgresAuthority(Connection db, String table, HaStaticProfile profile, long leaseMillis) throws SQLException {
        this.db = db;
        this.table = table;
        this.profile = profile;
        this.config = profile.configurationIdentity();
        this.leaseMillis = leaseMillis;
        var previous = lock();
        if (previous.leased()) throw new SQLException("Runtime already has a current owner");
        identity = new Identity(previous.incarnation, UUID.randomUUID(), Math.incrementExact(previous.generation));
        try (var update = db.prepareStatement("""
                UPDATE %s SET generation=?, attempt=?, role='recovering', lease_until=? WHERE singleton=1
                """.formatted(table))) {
            update.setLong(1, identity.generation);
            update.setObject(2, identity.attempt);
            update.setObject(3, deadline(previous));
            changed(update.executeUpdate());
        }
    }

    Identity identity() { return identity; }

    @FunctionalInterface
    interface QueryBudget { void refresh() throws SQLException; }

    private Row lock() throws SQLException { return lock(() -> {}); }

    private Row lock(QueryBudget budget) throws SQLException {
        budget.refresh();
        try (var sql = db.createStatement(); var row = sql.executeQuery("""
                SELECT schema_version,profile,runtime_id,tenant,configuration,incarnation,attempt,generation,
                       role,revision,lease_until FROM %s WHERE singleton=1 FOR UPDATE
                """.formatted(table))) {
            if (!row.next() || row.getInt("schema_version") != 2 || !HaStaticProfile.NAME.equals(row.getString("profile"))
                    || !Arrays.equals(PostgresSchema.bytes(profile.runtimeId()), row.getBytes("runtime_id"))
                    || !Arrays.equals(PostgresSchema.bytes(profile.tenant()), row.getBytes("tenant"))
                    || !config.equals(row.getString("configuration"))) {
                throw new java.sql.SQLNonTransientException("Incompatible PostgreSQL runtime binding");
            }
            // A row-lock wait can outlive the lease. Only sample the database clock after the lock is held.
            budget.refresh();
            try (var clock = db.createStatement(); var time = clock.executeQuery("SELECT pg_catalog.clock_timestamp()")) {
                time.next();
                return new Row(row.getObject("incarnation", UUID.class), row.getObject("attempt", UUID.class),
                        row.getLong("generation"), row.getString("role"), row.getLong("revision"),
                        row.getObject("lease_until", OffsetDateTime.class), time.getObject(1, OffsetDateTime.class));
            }
        }
    }

    private Row require(String role) throws SQLException {
        return require(lock(), role);
    }

    private Row require(Row row, String role) throws SQLException {
        if (!matches(row) || !row.leased() || !role.equals(row.role)) throw new SQLException("Runtime authority lost");
        return row;
    }

    private boolean matches(Row row) {
        return identity.incarnation.equals(row.incarnation) && identity.attempt.equals(row.attempt)
                && identity.generation == row.generation;
    }

    private OffsetDateTime deadline(Row row) {
        return row.now.plus(Duration.ofMillis(leaseMillis));
    }

    PostgresImageRow recover() throws SQLException {
        long revision = require("recovering").revision;
        try (var sql = db.createStatement(); var result = sql.executeQuery("SELECT image FROM " + table + " WHERE singleton=1")) {
            result.next();
            return new PostgresImageRow(revision, result.getString(1));
        }
    }

    record PostgresImageRow(long revision, String image) {}

    void activate(long revision) throws SQLException {
        var row = require("recovering");
        verifyRevision(row, revision);
        try (var sql = db.createStatement()) {
            changed(sql.executeUpdate("UPDATE " + table + " SET role='active' WHERE singleton=1"));
        }
    }

    void renew(boolean active) throws SQLException {
        var row = require(active ? "active" : "recovering");
        try (var update = db.prepareStatement("UPDATE " + table + " SET lease_until=? WHERE singleton=1")) {
            update.setObject(1, deadline(row));
            changed(update.executeUpdate());
        }
    }

    long capture(long revision) throws SQLException {
        var row = require("active");
        verifyRevision(row, revision);
        return revision;
    }

    void probe(long revision, QueryBudget budget) throws SQLException {
        verifyRevision(require(lock(budget), "active"), revision);
    }

    long admit(long contentRevision, long installedRevision) throws SQLException {
        var row = require("active");
        verifyRevision(row, installedRevision);
        if (contentRevision > row.revision) throw new SQLException("Content exceeds authoritative revision");
        return row.revision;
    }

    void write(long expected, long revision, String image) throws SQLException {
        verifyRevision(require("active"), expected);
        if (revision != Math.incrementExact(expected)) throw new SQLException("Invalid next revision");
        try (var update = db.prepareStatement("UPDATE " + table + " SET revision=?, image=? WHERE singleton=1")) {
            update.setLong(1, revision);
            update.setString(2, image);
            changed(update.executeUpdate());
        }
    }

    void release() throws SQLException {
        var row = lock();
        if (matches(row) && row.leased()) {
            try (var update = db.createStatement()) {
                changed(update.executeUpdate("UPDATE " + table + " SET attempt=NULL, role=NULL, lease_until=NULL WHERE singleton=1"));
            }
        }
    }

    private static void verifyRevision(Row row, long expected) throws SQLException {
        if (row.revision != expected) throw new SQLException("PostgreSQL revision conflict");
    }

    private static void changed(int rows) throws SQLException {
        if (rows != 1) throw new SQLException("Missing PostgreSQL authority row");
    }
}
