package io.zooglass.v2;

import org.sqlite.JDBC;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.Collections;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import java.util.logging.Logger;

/** Child-JVM-only instrumentation around real SQLite calls, never a replacement store. */
final class CrashBoundaryDriver implements Driver {
    enum Boundary { AFTER_STREAM_WRITE, BEFORE_COMMIT, AFTER_COMMIT, AFTER_ACK }

    private final Driver sqlite = new JDBC();
    private final Boundary boundary;
    private volatile boolean armed;
    private boolean timerOnly;

    CrashBoundaryDriver(Boundary boundary) throws SQLException {
        this.boundary = boundary;
        for (Driver driver : Collections.list(DriverManager.getDrivers())) {
            if (driver instanceof JDBC) {
                DriverManager.deregisterDriver(driver);
            }
        }
        DriverManager.registerDriver(this);
    }

    void arm(boolean timerOnly) {
        this.timerOnly = timerOnly;
        armed = true;
    }

    @Override
    public Connection connect(String url, Properties properties) throws SQLException {
        Connection connection = sqlite.connect(url, properties);
        if (connection == null) {
            return null;
        }
        return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[] { Connection.class }, (proxy, method, args) -> {
                    if (method.getName().equals("commit")) {
                        pause(Boundary.BEFORE_COMMIT);
                        Object result = invoke(connection, method, args);
                        pause(Boundary.AFTER_COMMIT);
                        return result;
                    }
                    Object result = invoke(connection, method, args);
                    if (method.getName().equals("prepareStatement")
                            && ((String) args[0]).startsWith("INSERT OR REPLACE INTO streams")) {
                        return instrumentStreamWrite((PreparedStatement) result);
                    }
                    return result;
                });
    }

    private PreparedStatement instrumentStreamWrite(PreparedStatement statement) {
        return (PreparedStatement) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[] { PreparedStatement.class }, (proxy, method, args) -> {
                    Object result = invoke(statement, method, args);
                    if (method.getName().equals("executeUpdate")) {
                        pause(Boundary.AFTER_STREAM_WRITE);
                    }
                    return result;
                });
    }

    private void pause(Boundary reached) throws InterruptedException {
        if (armed && boundary == reached && (!timerOnly || Thread.currentThread().getName().equals("zooglass-receipt-age"))) {
            System.out.println("CRASH_BOUNDARY " + reached);
            System.out.flush();
            new CountDownLatch(1).await(); // Parent must force-kill, not release or close us.
        }
    }

    private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    @Override
    public boolean acceptsURL(String url) throws SQLException {
        return sqlite.acceptsURL(url);
    }

    @Override
    public DriverPropertyInfo[] getPropertyInfo(String url, Properties properties) throws SQLException {
        return sqlite.getPropertyInfo(url, properties);
    }

    @Override
    public int getMajorVersion() { return sqlite.getMajorVersion(); }

    @Override
    public int getMinorVersion() { return sqlite.getMinorVersion(); }

    @Override
    public boolean jdbcCompliant() { return sqlite.jdbcCompliant(); }

    @Override
    public Logger getParentLogger() { return Logger.getLogger("sqlite-crash-test"); }
}
