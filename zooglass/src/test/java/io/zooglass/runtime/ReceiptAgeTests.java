package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

class ReceiptAgeTests {

    @TempDir Path directory;

    static final class Clock implements ReceiptClock {

        long wall = 1_000_000;
        long elapsed;

        public long wallMillis() {
            return wall;
        }

        public long monotonicMillis() {
            return elapsed;
        }

        void advance(long millis) {
            wall += millis;
            elapsed += millis;
        }
    }

    static RuntimeConfiguration config(String storage, long threshold) {
        var source =
                new RuntimeConfiguration.Source(
                        "fleet",
                        "v1",
                        new RuntimeConfiguration.Progress("contiguousSequence", 1L, 20L, 20L));
        var freshness = new RuntimeConfiguration.Freshness("receiptAge", threshold);
        var position =
                new RuntimeConfiguration.Field(
                        "fleet", "position", "latestBySequence", null, null, null, freshness);
        var history =
                new RuntimeConfiguration.Field(
                        "fleet", "position", "historyBySequence", null, null, null, freshness);
        var other = new RuntimeConfiguration.Field("fleet", "other", "arrival");
        var gate =
                new RuntimeConfiguration.Exposure(
                        "requireContributions", List.of("position", "other"), 2L);
        var view =
                new RuntimeConfiguration.View(
                        "fleet",
                        Map.of("position", position, "history", history, "other", other),
                        null,
                        gate);
        return new RuntimeConfiguration(2, storage, 20, 20, 20, List.of(source), List.of(view));
    }

    static ViewCoordinator.Snapshot snapshot(ViewCoordinator service) {
        return service.snapshot("fleet", "car").orElseThrow();
    }

    static ViewStatus.FieldStatus position(ViewCoordinator service) {
        return snapshot(service).status().fields().get("position");
    }

    @Test
    void silenceExpiresAtEqualityAndOnlyAcceptedChangesRefreshTheRelevantField() {
        var clock = new Clock();
        try (var service = new ViewCoordinator(config("memory", 5000), "", clock)) {
            assertThat(position(service).freshness()).isEqualTo("absent");
            var first = service.apply(ProgressTests.event(2));
            clock.advance(4999);
            service.advance(ProgressTests.watermark(2));
            service.apply(ProgressTests.event(1));
            assertThat(service.apply(ProgressTests.event(2)).version()).isEqualTo(first.version());
            var before = snapshot(service);
            assertThat(position(service).receivedAtMillis()).isEqualTo(1_000_000);
            assertThat(position(service).freshness()).isEqualTo("fresh");
            clock.wall -= 20000;
            clock.elapsed++;
            var stale = snapshot(service);
            assertThat(position(service).freshness()).isEqualTo("stale");
            assertThat(stale.status().fields().get("history").freshness()).isEqualTo("fresh");
            assertThat(stale.version()).isEqualTo(before.version() + 1);
            assertThat(snapshot(service)).isEqualTo(stale);
            assertThat(stale.status().publication()).isEqualTo("waiting");
            assertThat(stale.data()).isEmpty();
            service.apply(IdentityFixtures.parse("fleet", "v1", "car", 3, "other", "{}"));
            assertThat(snapshot(service).status().publication()).isEqualTo("ready");
            assertThat(position(service).freshness()).isEqualTo("stale");
            service.apply(ProgressTests.event(4));
            assertThat(position(service).freshness()).isEqualTo("fresh");
            assertThat(snapshot(service).status().fields().get("other").freshness())
                    .isEqualTo("unspecified");
        }
    }

    @Test
    void replacingAReportRemovesItsEarlierDeadline() {
        var clock = new Clock();
        try (var service = new ViewCoordinator(config("memory", 5000), "", clock)) {
            service.apply(ProgressTests.event(1));
            clock.advance(4500);
            service.apply(ProgressTests.event(2));
            long version = snapshot(service).version();
            clock.advance(500);
            assertThat(position(service).freshness()).isEqualTo("fresh");
            assertThat(snapshot(service).version()).isEqualTo(version);
            clock.advance(4500);
            assertThat(position(service).freshness()).isEqualTo("stale");
            assertThat(snapshot(service).version()).isEqualTo(version + 1);
        }
    }

    @Test
    void restartCountsDowntimeAndRollbackStaysUnknownUntilANewContribution() {
        var config = config("sqlite", 10000);
        var clock = new Clock();
        String db = directory.resolve("age.sqlite").toString();
        try (var service = new ViewCoordinator(config, db, clock)) {
            service.apply(ProgressTests.event(1));
        }
        clock.advance(9999);
        try (var service = new ViewCoordinator(config, db, clock)) {
            assertThat(position(service).freshness()).isEqualTo("fresh");
            clock.advance(1);
            assertThat(position(service).freshness()).isEqualTo("stale");
        }
        clock.wall -= 1;
        try (var service = new ViewCoordinator(config, db, clock)) {
            assertThat(position(service).freshness()).isEqualTo("ageUnknown");
            assertThat(position(service).receivedAtMillis()).isNull();
            assertThat(service.apply(ProgressTests.event(1)).status()).isEqualTo("duplicate");
        }
        clock.advance(20000);
        try (var service = new ViewCoordinator(config, db, clock)) {
            assertThat(position(service).freshness()).isEqualTo("ageUnknown");
            service.apply(ProgressTests.event(2));
            assertThat(position(service).freshness()).isEqualTo("fresh");
        }
        clock.advance(10000);
        try (var service = new ViewCoordinator(config, db, clock)) {
            assertThat(position(service).freshness()).isEqualTo("stale");
        }
    }
}
