package io.zooglass.runtime;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/** Each test owns a unique schema in the explicitly supplied disposable PostgreSQL fixture. */
public final class PostgresTestDatabase implements AutoCloseable {
    private final String url = required("ZOOGLASS_POSTGRES_URL");
    private final Properties credentials = new Properties();
    private final String schema = "zg_test_" + UUID.randomUUID().toString().replace("-", "");

    public PostgresTestDatabase() throws SQLException {
        if (!url.startsWith("jdbc:postgresql:")) throw new IllegalArgumentException("Expected a PostgreSQL JDBC fixture");
        credentials.setProperty("user", required("ZOOGLASS_POSTGRES_USER"));
        credentials.setProperty("password", required("ZOOGLASS_POSTGRES_PASSWORD"));
        credentials.setProperty("connectTimeout", "5");
        credentials.setProperty("loginTimeout", "5");
        credentials.setProperty("socketTimeout", "15");
        try (var db = connect(); var sql = db.createStatement()) {
            sql.execute("CREATE SCHEMA " + schema);
        }
    }

    private static String required(String name) {
        var value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalStateException("Missing required fixture setting " + name);
        return value;
    }

    private Connection connect() throws SQLException {
        return DriverManager.getConnection(url, credentials);
    }

    public String schema() { return schema; }

    public Connection open() throws SQLException {
        var db = connect();
        try (var sql = db.createStatement()) {
            sql.execute("SET search_path TO " + schema);
            return db;
        } catch (SQLException failure) {
            db.close();
            throw failure;
        }
    }

    Connection interruptCommit(AtomicBoolean armed, boolean afterCommit) throws SQLException {
        return interruptCommit(armed, afterCommit, new SQLException("Simulated loss of commit response"));
    }

    Connection interruptCommit(AtomicBoolean armed, boolean afterCommit, Exception failureAfterCommit) throws SQLException {
        var db = open();
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("commit") && armed.compareAndSet(true, false)) {
                        if (afterCommit) db.commit();
                        throw failureAfterCommit;
                    }
                    try {
                        return method.invoke(db, args);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    void expireLease() throws SQLException {
        execute("UPDATE zooglass_runtime SET lease_until=clock_timestamp()-interval '1 second' WHERE attempt IS NOT NULL");
    }

    void execute(String sql) throws SQLException {
        try (var db = open(); var statement = db.createStatement()) {
            statement.execute(sql);
        }
    }

    @Override
    public void close() throws SQLException {
        try (var db = connect(); var sql = db.createStatement()) {
            sql.execute("DROP SCHEMA " + schema + " CASCADE");
        }
    }
}
