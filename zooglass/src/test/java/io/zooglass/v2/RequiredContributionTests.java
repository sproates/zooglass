package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RequiredContributionTests {
    @TempDir Path directory;

    static V2Configuration configuration(String storage) {
        var fields = Map.of("order", field("orders"), "payment", field("payments"), "stock", field("stock"));
        var gate = new V2Configuration.Exposure("requireContributions", List.of("payment", "order"), 1L);
        return new V2Configuration(2, storage, 50, 20, 20,
                List.of(source("orders"), source("payments"), source("stock")),
                List.of(new V2Configuration.View("overview", fields),
                        new V2Configuration.View("dispatch", fields, null, gate)));
    }

    private static V2Configuration.Source source(String id) {
        return new V2Configuration.Source(id, "v1", new V2Configuration.Progress("contiguousSequence", 1L, 10L, 10L));
    }

    private static V2Configuration.Field field(String source) {
        return new V2Configuration.Field(source, "updated", "latestBySequence");
    }

    static Publication report(String source, String entity, long sequence) {
        return IdentityFixtures.parse(source, "v1", entity, sequence, "updated", "{}");
    }

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void releaseIncludesAllHeldValuesAndOverflowRollsBackEveryTarget(String storage) {
        try (var runtime = new ViewCoordinator(configuration(storage), directory.resolve("db").toString())) {
            var empty = runtime.snapshot("dispatch", "A").orElseThrow();
            assertThat(empty.version()).isZero();
            assertThat(empty.status().missingRequiredFields()).containsExactly("order", "payment");
            runtime.advance(new ProgressControl("orders", "v1", "B", 1));
            runtime.apply(report("orders", "A", 1));
            var waiting = runtime.snapshot("dispatch", "A").orElseThrow();
            assertThat(waiting.status().publication()).isEqualTo("waiting");
            assertThat(waiting.status().missingRequiredFields()).containsExactly("payment");
            assertThat(waiting.data()).isEmpty();
            assertThat(waiting.provenance()).isEmpty();
            assertThat(runtime.snapshot("overview", "A").orElseThrow().data()).containsOnlyKeys("order");

            var before = runtime.snapshot("overview", "B");
            var excess = report("payments", "B", 1);
            var rejected = runtime.apply(excess);
            assertThat(rejected.reason()).isEqualTo("pendingViewLimit");
            assertThat(rejected.targets()).isEmpty();
            assertThat(runtime.snapshot("overview", "B")).isEqualTo(before);

            var outcome = runtime.apply(report("payments", "A", 2)).targets().getLast();
            assertThat(outcome.changedFields()).containsExactly("order", "payment");
            assertThat(outcome.fields()).containsExactly(new TargetOutcome.FieldOutcome("payment", "accepted", null, true));
            var released = runtime.snapshot("dispatch", "A").orElseThrow();
            assertThat(released.status().publication()).isEqualTo("partial");
            assertThat(released.status().missingFields()).containsExactly("stock");
            assertThat(released.status().missingRequiredFields()).isEmpty();
            assertThat(released.data()).containsOnlyKeys("order", "payment");
            assertThat(released.provenance()).containsOnlyKeys("order", "payment");
            assertThat(runtime.apply(excess).targets()).hasSize(2);
            runtime.apply(report("stock", "A", 1));
            assertThat(runtime.snapshot("dispatch", "A").orElseThrow().status().publication()).isEqualTo("ready");
        }
    }

    @Test
    void untrackedHiddenUpdatesKeepPublicVersionAndReleaseTheLatestOptionalValue() {
        var original = configuration("memory");
        var config = new V2Configuration(2, "memory", 50, 20, 20,
                original.sources().stream().map(source -> new V2Configuration.Source(source.id(), source.epoch())).toList(),
                original.views());
        try (var runtime = new ViewCoordinator(config)) {
            runtime.apply(report("stock", "A", 1));
            var before = runtime.snapshot("dispatch", "A");
            var update = runtime.apply(report("stock", "A", 2));
            assertThat(update.changedViews()).containsExactly("overview");
            assertThat(runtime.snapshot("dispatch", "A")).isEqualTo(before);
            runtime.apply(report("payments", "A", 1));
            var release = runtime.apply(report("orders", "A", 1)).targets().getLast();
            assertThat(release.changedFields()).containsExactly("order", "payment", "stock");
            assertThat(runtime.snapshot("dispatch", "A").orElseThrow().data()
                    .get("stock").path("publicationSequence").longValue()).isEqualTo(2);
        }
    }

    @Test
    void aDirectReleaseNeedsNoSlotEvenWhenAnotherEntityIsWaiting() {
        var original = configuration("memory");
        var fields = original.views().getFirst().fields();
        var gate = new V2Configuration.Exposure("requireContributions", List.of("order"), 1L);
        var view = new V2Configuration.View("dispatch", fields, null, gate);
        var config = new V2Configuration(2, "memory", 50, 20, 20, original.sources(), List.of(view));
        try (var runtime = new ViewCoordinator(config)) {
            runtime.apply(report("stock", "A", 1));
            assertThat(runtime.apply(report("orders", "B", 1)).status()).isEqualTo("applied");
            assertThat(runtime.apply(report("stock", "C", 1)).reason()).isEqualTo("pendingViewLimit");
        }
    }

    @Test
    void restartPreservesWaitingCapacityAndOriginalReleaseReceipt() {
        var config = configuration("sqlite");
        String db = directory.resolve("db").toString();
        var first = report("orders", "A", 1);
        var last = report("payments", "A", 1);
        try (var runtime = new ViewCoordinator(config, db)) {
            runtime.apply(first);
        }
        PublicationOutcome released;
        try (var runtime = new ViewCoordinator(config, db)) {
            assertThat(runtime.snapshot("dispatch", "A").orElseThrow().data()).isEmpty();
            assertThat(runtime.apply(first).targets().getLast().changedFields()).isEmpty();
            assertThat(runtime.apply(report("orders", "B", 1)).reason()).isEqualTo("pendingViewLimit");
            released = runtime.apply(last);
        }
        try (var runtime = new ViewCoordinator(config, db)) {
            assertThat(runtime.apply(last).targets()).isEqualTo(released.targets());
            assertThat(runtime.snapshot("dispatch", "A").orElseThrow().data()).containsOnlyKeys("order", "payment");
            assertThat(runtime.apply(report("orders", "B", 1)).status()).isEqualTo("committed");
        }
    }
}
