package io.zooglass.runtime;

import io.zooglass.access.ViewResource;
import io.zooglass.simulation.RuntimeGeneration;
import io.zooglass.simulation.TurnContext;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.List;

/** Composition adapter; all reconciliation remains in the shared production runtime. */
public final class TimelineRuntime {
    private TimelineRuntime() {}

    public static RuntimeConfiguration inspectConfiguration(String json) {
        return RuntimeConfiguration.parseConfiguration(json);
    }

    public static ViewCoordinator create(
            RuntimeConfiguration config, TurnContext turns, RuntimeGeneration generation,
            Path database) {
        turns.check();
        return new ViewCoordinator(
                config,
                database == null ? "" : database.toString(),
                new ControlledReceiptClock(turns, generation),
                null,
                () -> new ControlledAlarmScheduler(turns));
    }

    public static List<ViewCoordinator.Snapshot> installedSnapshots(
            ViewCoordinator runtime, List<ViewResource> targets) {
        return targets.stream()
                .map(target -> runtime.installedSnapshot(target.viewId(), target.entityId())
                        .orElseThrow(() -> new IllegalStateException("Unknown installed view")))
                .toList();
    }

    public static void verifyStorageAvailable(ViewCoordinator runtime) {
        if (!runtime.healthy()) throw new IllegalStateException("SQLite storage requires recovery");
    }

    /** Native version metadata, using no scenario state or virtual clock. */
    public static String sqliteVersion() {
        try (var connection = DriverManager.getConnection("jdbc:sqlite::memory:");
                var statement = connection.createStatement();
                var result = statement.executeQuery("SELECT sqlite_version()")) {
            if (!result.next()) throw new IllegalStateException("Missing SQLite native version");
            return result.getString(1);
        } catch (SQLException failure) {
            throw new IllegalStateException("Cannot identify SQLite native version", failure);
        }
    }
}
