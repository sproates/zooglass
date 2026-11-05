package io.zooglass.runtime;

import static io.zooglass.runtime.IdentityFixtures.parse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.core.io.DefaultResourceLoader;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

class EntityMappingTests {

    @TempDir Path directory;

    static RuntimeConfiguration configuration(String storage) {
        var config =
                RuntimeConfiguration.load(
                        new DefaultResourceLoader(), "classpath:mapped-views-test.json");
        return new RuntimeConfiguration(2, storage, 10, 10, 3, config.sources(), config.views());
    }

    static Publication payment(String entity, long sequence) {
        return parse("payments", "v1", entity, sequence, "updated", "{\"paid\":true}");
    }

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void independentSourcesConvergeWithoutChangingTheirIdentityOrSequenceDomain(String storage) {
        try (var runtime =
                new ViewCoordinator(
                        configuration(storage), directory.resolve("state.db").toString())) {
            runtime.apply(parse("orders", "v1", "order-42", 900, "updated", "{\"placed\":true}"));
            var paid = runtime.apply(payment("payment-9", 2));
            runtime.apply(
                    parse("stock", "v1", "reservation-7", 1, "updated", "{\"reserved\":true}"));
            assertThat(paid.stream().sourceEntityId()).isEqualTo("payment-9");
            assertThat(paid.targets())
                    .containsExactly(
                            new TargetOutcome(
                                    "summary", "order-42", "accepted", null, List.of("payment")),
                            new TargetOutcome(
                                    "detail", "payment-9", "accepted", null, List.of("payment")));
            var summary = runtime.snapshot("summary", "order-42").orElseThrow();
            assertThat(summary.data()).containsOnlyKeys("order", "payment", "stock");
            assertThat(summary.data().get("order").at("/payload/placed").booleanValue()).isTrue();
            assertThat(summary.data().get("payment").path("publicationSequence").longValue())
                    .isEqualTo(2);
            assertThat(summary.provenance())
                    .containsEntry("payment", new Provenance("payments", "v1", "payment-9"))
                    .containsEntry("stock", new Provenance("stock", "v1", "reservation-7"));
            assertThat(runtime.snapshot("summary", "payment-9").orElseThrow().data()).isEmpty();
            var delayed = runtime.apply(payment("payment-9", 1));
            assertThat(delayed.changedViews()).isEmpty();
            assertThat(delayed.targets())
                    .allSatisfy(
                            target -> {
                                assertThat(target.status()).isEqualTo("accepted");
                                assertThat(target.changedFields()).isEmpty();
                            });
            assertThat(runtime.snapshot("summary", "order-42").orElseThrow()).isEqualTo(summary);
            assertThat(runtime.apply(payment("payment-9", 2)).targets()).isEqualTo(paid.targets());
            assertThat(
                            runtime.apply(parse("payments", "v1", "payment-9", 2, "updated", "{}"))
                                    .targets())
                    .isEmpty();
            assertThatThrownBy(() -> summary.provenance().clear())
                    .isInstanceOf(UnsupportedOperationException.class);
            assertThatThrownBy(() -> paid.targets().getFirst().changedFields().clear())
                    .isInstanceOf(UnsupportedOperationException.class);
        }
    }

    @Test
    void rejectedTargetAndOriginalReceiptSurviveRestartAndNewMappingsDoNotBackfillRetries() {
        String database = directory.resolve("state.db").toString();
        var config = configuration("sqlite");
        PublicationOutcome original;
        try (var runtime = new ViewCoordinator(config, database)) {
            original = runtime.apply(payment("unknown", 1));
            assertThat(original.status()).isEqualTo("committed");
            assertThat(original.changedViews()).containsExactly("detail");
            assertThat(original.targets())
                    .containsExactly(
                            new TargetOutcome(
                                    "summary", null, "rejected", "unknownEntityMapping", List.of()),
                            new TargetOutcome(
                                    "detail", "unknown", "accepted", null, List.of("payment")));
        }
        var views = new ArrayList<>(config.views());
        views.add(
                new RuntimeConfiguration.View(
                        "new-summary",
                        Map.of(
                                "payment",
                                new RuntimeConfiguration.Field(
                                        "payments", "updated", "latestBySequence")),
                        Map.of(
                                "payments",
                                new RuntimeConfiguration.Entity(
                                        "lookupEntity", Map.of("unknown", "order-99")))));
        var extended = new RuntimeConfiguration(2, "sqlite", 10, 10, 3, config.sources(), views);
        try (var runtime = new ViewCoordinator(extended, database)) {
            var retry = runtime.apply(payment("unknown", 1));
            assertThat(retry.targets()).isEqualTo(original.targets());
            assertThat(retry.version()).isEqualTo(original.version());
            assertThat(retry.changedViews()).isEmpty();
            assertThatThrownBy(() -> retry.targets().clear())
                    .isInstanceOf(UnsupportedOperationException.class);
            assertThatThrownBy(
                            () ->
                                    runtime.snapshot("detail", "unknown")
                                            .orElseThrow()
                                            .provenance()
                                            .clear())
                    .isInstanceOf(UnsupportedOperationException.class);
            assertThat(runtime.snapshot("new-summary", "order-99").orElseThrow().data()).isEmpty();
            assertThat(runtime.snapshot("summary", "unknown").orElseThrow().provenance()).isEmpty();
            runtime.apply(payment("unknown", 2));
            assertThat(runtime.snapshot("new-summary", "order-99").orElseThrow().provenance())
                    .containsEntry("payment", new Provenance("payments", "v1", "unknown"));
        }
    }

    @Test
    void allRejectedStillAdmitsIdentityButWrongTypeDoesNotResolveTargets() {
        var initial = configuration("memory");
        var config =
                new RuntimeConfiguration(
                        2,
                        "memory",
                        1,
                        2,
                        3,
                        initial.sources(),
                        List.of(initial.views().getFirst()));
        try (var runtime = new ViewCoordinator(config)) {
            assertThat(runtime.apply(payment("missing", 1)).targets())
                    .containsExactly(
                            new TargetOutcome(
                                    "summary",
                                    null,
                                    "rejected",
                                    "unknownEntityMapping",
                                    List.of()));
            assertThat(runtime.apply(payment("missing", 1)).status()).isEqualTo("duplicate");
            assertThat(
                            runtime.apply(parse("payments", "v1", "missing", 3, "other", "{}"))
                                    .targets())
                    .isEmpty();
            assertThat(runtime.apply(payment("missing", 1)).reason()).isEqualTo("outsideRetention");
            assertThat(runtime.apply(payment("missing", 1)).targets()).isEmpty();
            assertThat(runtime.apply(payment("payment-9", 1)).reason()).isEqualTo("streamLimit");
        }
    }

    @Test
    void mappedHistoryAndArrivalUseSortedFieldOutcomesAndRetainProvenance() {
        var initial = configuration("memory");
        var view =
                new RuntimeConfiguration.View(
                        "mapped",
                        Map.of(
                                "zHistory",
                                new RuntimeConfiguration.Field(
                                        "payments", "updated", "historyBySequence"),
                                "aArrival",
                                new RuntimeConfiguration.Field("payments", "updated", "arrival")),
                        Map.of(
                                "payments",
                                new RuntimeConfiguration.Entity(
                                        "lookupEntity", Map.of("payment-9", "order-42"))));
        var config =
                new RuntimeConfiguration(2, "memory", 10, 10, 3, initial.sources(), List.of(view));
        try (var runtime = new ViewCoordinator(config)) {
            assertThat(runtime.apply(payment("payment-9", 2)).targets().getFirst().changedFields())
                    .containsExactly("aArrival", "zHistory");
            runtime.apply(payment("payment-9", 1));
            var snapshot = runtime.snapshot("mapped", "order-42").orElseThrow();
            assertThat(snapshot.data().get("zHistory"))
                    .extracting(value -> value.path("publicationSequence").longValue())
                    .containsExactly(1L, 2L);
            assertThat(snapshot.data().get("aArrival").path("publicationSequence").longValue())
                    .isEqualTo(1);
            assertThat(snapshot.provenance().values())
                    .containsOnly(new Provenance("payments", "v1", "payment-9"));
        }
    }

    @Test
    void capacityFailureDiscardsStagedTargetOutcomesAndProvenance() {
        var initial = configuration("memory");
        var views = new ArrayList<>(initial.views());
        views.add(
                new RuntimeConfiguration.View(
                        "history",
                        Map.of(
                                "events",
                                new RuntimeConfiguration.Field(
                                        "payments", "updated", "historyBySequence"))));
        var config = new RuntimeConfiguration(2, "memory", 10, 10, 1, initial.sources(), views);
        try (var runtime = new ViewCoordinator(config)) {
            var first = runtime.apply(payment("payment-9", 1));
            var before = runtime.snapshot("summary", "order-42");
            var failed = runtime.apply(payment("payment-9", 2));
            assertThat(failed.reason()).isEqualTo("historyLimit");
            assertThat(failed.targets()).isEmpty();
            assertThat(runtime.snapshot("summary", "order-42")).isEqualTo(before);
            assertThat(runtime.apply(payment("payment-9", 1)).targets()).isEqualTo(first.targets());
            assertThat(runtime.apply(payment("payment-9", 2)).reason()).isEqualTo("historyLimit");
        }
    }
}
