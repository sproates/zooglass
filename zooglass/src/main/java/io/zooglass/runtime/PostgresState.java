package io.zooglass.runtime;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.function.UnaryOperator;

/** One candidacy attempt and one detached cache. Confined to its owning runtime monitor. */
final class PostgresState implements StateStore {
    @FunctionalInterface
    interface Connections {
        Connection open() throws SQLException;
    }

    @FunctionalInterface
    private interface Transaction<T> {
        T run() throws SQLException;
    }

    private final Connection db;
    private final HaStaticProfile profile;
    private final PostgresAuthority authority;
    private StateImage current;
    private boolean closed;
    private boolean active;

    PostgresState(HaStaticProfile profile, Connections connections, Duration lease) {
        this.profile = profile;
        long leaseMillis = PostgresAuthority.leaseMillis(lease);
        try {
            db = connections.open();
        } catch (SQLException failure) {
            throw new IllegalStateException("Cannot open PostgreSQL state", failure);
        }
        authority = transaction(() -> {
            var schema = new PostgresSchema(db, profile);
            return new PostgresAuthority(db, schema.table, profile, leaseMillis);
        });
    }

    PostgresAuthority.Identity identity() { return authority.identity(); }

    void recover() {
        if (current != null) throw new IllegalStateException("Cache already restored");
        var row = transaction(authority::recover);
        try {
            current = PostgresImage.restore(row.image(), row.revision(), profile.configuration());
        } catch (RuntimeException failure) {
            throw invalidate(failure);
        }
    }

    void activate() {
        long revision = current().version();
        transaction(() -> {
            authority.activate(revision);
            return null;
        });
        active = true;
    }

    void renew() {
        transaction(() -> {
            authority.renew(active);
            return null;
        });
    }

    private <T> T transaction(Transaction<T> operation) {
        if (closed) throw new StorageUnavailable("PostgreSQL attempt requires recovery", null);
        try {
            T result = operation.run();
            db.commit();
            return result;
        } catch (SQLException | RuntimeException failure) {
            throw invalidate(failure);
        }
    }

    StorageUnavailable invalidate(Exception failure) {
        current = null;
        active = false;
        if (!closed) {
            closed = true;
            try {
                db.rollback();
            } catch (SQLException rollback) {
                failure.addSuppressed(rollback);
            }
            try {
                db.close();
            } catch (SQLException cleanup) {
                failure.addSuppressed(cleanup);
            }
        }
        return new StorageUnavailable("PostgreSQL attempt requires recovery", failure);
    }

    long capture() {
        return transaction(() -> authority.capture(current().version()));
    }

    long admit(long contentRevision) {
        return transaction(() -> authority.admit(contentRevision, current().version()));
    }

    @Override
    public StateImage current() {
        if (closed || current == null) throw new StorageUnavailable("PostgreSQL cache is unavailable", null);
        return current;
    }

    @Override
    public void install(StateImage next) {
        long previous = current().version();
        transaction(() -> {
            // Complete local preparation before acquiring the database row lock.
            String image = PostgresImage.encode(next);
            authority.write(previous, next.version(), image);
            return null;
        });
        current = next;
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
        if (closed) return;
        try {
            transaction(() -> {
                authority.release();
                return null;
            });
        } finally {
            closed = true;
            active = false;
            current = null;
            try {
                db.close();
            } catch (SQLException failure) {
                throw new IllegalStateException("Cannot close PostgreSQL connection", failure);
            }
        }
    }
}
