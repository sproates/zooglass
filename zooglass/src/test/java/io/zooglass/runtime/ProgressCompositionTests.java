package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.strategy.progress.ProgressState;

import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

class ProgressCompositionTests {

    @TempDir Path directory;

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void requiredPresenceDoesNotHideSilenceOrAnotherSourcesMissingReport(String storage) {
        var clock = new ReceiptAgeTests.Clock();
        var config = configuration(storage);
        String database = directory.resolve("combined.sqlite").toString();
        ViewCoordinator.Snapshot released;

        try (var service = new ViewCoordinator(config, database, clock)) {
            service.apply(report("orders", 40));
            service.apply(report("orders", 42));
            service.advance(new ProgressControl("orders", "v1", "A", 42));
            var waiting = snapshot(service, "dispatch");
            assertThat(waiting.data()).isEmpty();
            assertThat(waiting.status().publication()).isEqualTo("waiting");
            assertThat(waiting.status().missingRequiredFields()).containsExactly("payment");
            assertThat(snapshot(service, "overview").data()).containsOnlyKeys("order");

            clock.advance(5000);
            var silent = snapshot(service, "dispatch");
            assertThat(silent.status().fields().get("order").freshness()).isEqualTo("stale");
            assertThat(silent.status().inputs().get("payments").state()).isEqualTo("notObserved");
            assertThat(silent.status().inputs().get("payments").completeness())
                    .isEqualTo("unknown");

            service.apply(report("payments", 900));
            service.advance(new ProgressControl("payments", "v1", "A", 900));
            released = snapshot(service, "dispatch");
            assertThat(released.status().publication()).isEqualTo("ready");
            assertThat(released.status().missingRequiredFields()).isEmpty();
            assertThat(released.data()).containsOnlyKeys("order", "payment");
            assertThat(released.provenance()).containsOnlyKeys("order", "payment");
            assertThat(released.data().get("order").path("publicationSequence").longValue())
                    .isEqualTo(42);
            assertThat(released.data().get("payment").path("publicationSequence").longValue())
                    .isEqualTo(900);
            assertThat(released.status().fields().get("order").freshness()).isEqualTo("stale");
            assertThat(released.status().fields().get("payment").freshness()).isEqualTo("fresh");
            assertThat(released.status().inputs().get("orders").completeness())
                    .isEqualTo("incomplete");
            assertThat(released.status().inputs().get("orders").missingRanges())
                    .containsExactly(new ProgressState.Missing(41, 41, "confirmed"));
            assertThat(released.status().inputs().get("payments").completeThrough()).isEqualTo(900);
            assertThat(released.status().inputs().get("payments").missingRanges()).isEmpty();

            // Retrying a receipt cannot make the silent source fresh or close its gap.
            assertThat(service.apply(report("orders", 42)).status()).isEqualTo("duplicate");
            assertThat(snapshot(service, "dispatch")).isEqualTo(released);
        }

        if (storage.equals("sqlite")) {
            try (var recovered = new ViewCoordinator(config, database, clock)) {
                assertSameSnapshot(snapshot(recovered, "dispatch"), released);
                assertThat(recovered.apply(report("payments", 900)).status())
                        .isEqualTo("duplicate");
                assertSameSnapshot(snapshot(recovered, "dispatch"), released);
            }
        }
    }

    private static void assertSameSnapshot(
            ViewCoordinator.Snapshot actual, ViewCoordinator.Snapshot expected) {
        // Compare the public JSON representation, independent of numeric node types after storage.
        var json = new JsonMapper();
        assertThat(json.readTree(json.writeValueAsString(actual)))
                .isEqualTo(json.readTree(json.writeValueAsString(expected)));
    }

    private static RuntimeConfiguration configuration(String storage) {
        var fields = Map.of("order", field("orders"), "payment", field("payments"));
        var gate =
                new RuntimeConfiguration.Exposure(
                        "requireContributions", List.of("order", "payment"), 10L);
        return new RuntimeConfiguration(
                2,
                storage,
                20,
                20,
                20,
                List.of(source("orders", 40), source("payments", 900)),
                List.of(
                        new RuntimeConfiguration.View("overview", fields),
                        new RuntimeConfiguration.View("dispatch", fields, null, gate)));
    }

    private static RuntimeConfiguration.Source source(String name, long start) {
        return new RuntimeConfiguration.Source(
                name,
                "v1",
                new RuntimeConfiguration.Progress("contiguousSequence", start, 10L, 10L));
    }

    private static RuntimeConfiguration.Field field(String source) {
        return new RuntimeConfiguration.Field(
                source,
                "updated",
                "latestBySequence",
                null,
                null,
                null,
                new RuntimeConfiguration.Freshness("receiptAge", 5000L));
    }

    private static Publication report(String source, long sequence) {
        return IdentityFixtures.parse(source, "v1", "A", sequence, "updated", "{}");
    }

    private static ViewCoordinator.Snapshot snapshot(ViewCoordinator service, String view) {
        return service.snapshot(view, "A").orElseThrow();
    }
}
