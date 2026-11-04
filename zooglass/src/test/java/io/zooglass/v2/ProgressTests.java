package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import io.zooglass.strategy.progress.ProgressState;

import static io.zooglass.v2.IdentityFixtures.parse;
import static org.assertj.core.api.Assertions.*;

class ProgressTests {
    @TempDir Path directory;

    static V2Configuration configuration(String storage) {
        var progress = new V2Configuration.Progress("contiguousSequence", 40L, 8L, 8L);
        var fields = Map.of("accept", field("historyBySequence", "acceptLate"),
                "reject", field("historyBySequence", "rejectBehindWatermark"),
                "latest", field("latestBySequence", "acceptLate"));
        return new V2Configuration(2, storage, 10, 10, 20,
                List.of(new V2Configuration.Source("fleet", "v1", progress),
                        new V2Configuration.Source("other", "v1", progress)),
                List.of(new V2Configuration.View("mixed", fields),
                        new V2Configuration.View("strict", Map.of("position", field("arrival", "rejectBehindWatermark")))));
    }

    private static V2Configuration.Field field(String mode, String late) {
        return new V2Configuration.Field("fleet", "position", mode, null, null, new V2Configuration.Late(late));
    }

    static Publication event(long sequence) { return parse("fleet", "v1", "car", sequence, "position", "{}"); }
    static ProgressControl watermark(long through) { return new ProgressControl("fleet", "v1", "car", through); }

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void lateFieldsDifferWhileAllViewsExposeSourcePromiseViolation(String storage) {
        String file = directory.resolve("state.db").toString();
        try (var runtime = new ViewCoordinator(configuration(storage), file)) {
            var forty = runtime.apply(event(40));
            runtime.apply(event(42));
            assertThat(input(runtime).missingRanges()).containsExactly(new ProgressState.Missing(41, 41, "provisional"));
            assertThat(runtime.advance(watermark(42)).version()).isEqualTo(3);
            assertThat(input(runtime).completeness()).isEqualTo("incomplete");
            assertThat(input(runtime).missingRanges().getFirst().status()).isEqualTo("confirmed");
            assertThat(runtime.apply(event(40)).targets()).isEqualTo(forty.targets());
            assertThat(input(runtime).sourceContractViolated()).isFalse();
            var late = runtime.apply(event(41));
            assertThat(late.targets().getFirst().status()).isEqualTo("accepted");
            assertThat(late.targets().getFirst().changedFields()).containsExactly("accept");
            assertThat(late.targets().getFirst().fields()).containsExactly(
                    new TargetOutcome.FieldOutcome("accept", "accepted", null, true),
                    new TargetOutcome.FieldOutcome("latest", "accepted", null, false),
                    new TargetOutcome.FieldOutcome("reject", "rejected", "behindWatermark", false));
            assertThat(late.targets().get(1).status()).isEqualTo("rejected");
            assertThat(late.targets().get(1).reason()).isEqualTo("behindWatermark");
            assertThat(late.changedViews()).containsExactly("mixed", "strict");
            assertThat(input(runtime).completeness()).isEqualTo("violated");
            assertThat(input(runtime).missingRanges()).isEmpty();
            assertThat(runtime.snapshot("mixed", "car").orElseThrow().data().get("accept")).hasSize(3);
            assertThat(runtime.snapshot("mixed", "car").orElseThrow().data().get("reject")).hasSize(2);
            assertThat(runtime.snapshot("strict", "car").orElseThrow().data().get("position").path("publicationSequence").longValue()).isEqualTo(42);
            assertThat(runtime.advance(watermark(42)).version()).isEqualTo(3);
            assertThat(runtime.advance(watermark(41)).reason()).isEqualTo("backwardsWatermark");
            assertThat(runtime.apply(event(39)).reason()).isEqualTo("beforeProgressStart");
        }
        if (storage.equals("sqlite")) {
            try (var recovered = new ViewCoordinator(configuration(storage), file)) {
                assertThat(input(recovered).completeness()).isEqualTo("violated");
                assertThat(recovered.apply(event(41)).status()).isEqualTo("duplicate");
                assertThat(recovered.advance(watermark(42)).version()).isEqualTo(3);
            }
        }
    }

    @Test
    void controlsCreateNoValuesAndUnmatchedTypesStillUpdateProgress() {
        try (var runtime = new ViewCoordinator(configuration("memory"))) {
            assertThat(runtime.advance(watermark(42)).changedViews()).containsExactly("mixed", "strict");
            assertThat(runtime.snapshot("mixed", "car").orElseThrow().data()).isEmpty();
            assertThat(runtime.snapshot("mixed", "car").orElseThrow().status().missingFields()).containsExactly("accept", "latest", "reject");
            assertThat(input(runtime).admissionFloor()).isEqualTo(1);
            var unrelatedType = runtime.apply(parse("fleet", "v1", "car", 43, "heartbeat", "{}"));
            assertThat(unrelatedType.targets()).isEmpty();
            assertThat(unrelatedType.changedViews()).containsExactly("mixed", "strict");
            assertThat(input(runtime).observedThrough()).isEqualTo(43);
            runtime.apply(parse("fleet", "v1", "another", 40, "position", "{}"));
            runtime.advance(new ProgressControl("other", "v1", "car", 900));
            assertThat(input(runtime).watermarkThrough()).isEqualTo(42);
            assertThat(runtime.snapshot("mixed", "another").orElseThrow().status().inputs().get("fleet").watermarkThrough()).isNull();
            assertThat(runtime.advance(new ProgressControl("fleet", "wrong", "car", 44)).reason()).isEqualTo("unknownEpoch");
            assertThat(runtime.advance(new ProgressControl("missing", "v1", "car", 44)).reason()).isEqualTo("unknownSource");
        }
    }

    @Test
    void filledGapBeforeWatermarkPermitsCompleteThroughOnlyThatBoundary() {
        try (var runtime = new ViewCoordinator(configuration("memory"))) {
            runtime.apply(event(40)); runtime.apply(event(42)); runtime.apply(event(41));
            runtime.advance(watermark(42));
            assertThat(input(runtime).completeness()).isEqualTo("completeThrough");
            assertThat(input(runtime).completeThrough()).isEqualTo(42);
            runtime.apply(event(44));
            assertThat(input(runtime).completeThrough()).isEqualTo(42);
            assertThat(input(runtime).missingRanges()).containsExactly(new ProgressState.Missing(43, 43, "provisional"));
        }
    }

    @Test
    void mappedSourcesReportIndependentProgressAndUnmappedKeysDoNotAllocateViewData() {
        var original = configuration("memory");
        var inputs = List.of(new V2Configuration.Input("fleet", "position"), new V2Configuration.Input("other", "position"));
        var field = new V2Configuration.Field(null, null, "latestBySequence", inputs,
                new V2Configuration.Conflict("sourcePriority", List.of("fleet", "other")));
        var view = new V2Configuration.View("mapped", Map.of("position", field), Map.of(
                "fleet", new V2Configuration.Entity("lookupEntity", Map.of("car", "order")),
                "other", new V2Configuration.Entity("lookupEntity", Map.of("truck", "order"))));
        var config = new V2Configuration(2, "memory", 10, 10, 20, original.sources(), List.of(view));
        try (var runtime = new ViewCoordinator(config)) {
            runtime.apply(event(40));
            runtime.advance(watermark(42));
            runtime.advance(new ProgressControl("other", "v1", "truck", 900));
            var snapshot = runtime.snapshot("mapped", "order").orElseThrow();
            assertThat(snapshot.status().inputs().get("fleet").watermarkThrough()).isEqualTo(42);
            assertThat(snapshot.status().inputs().get("other").watermarkThrough()).isEqualTo(900);
            assertThat(snapshot.status().inputs().get("fleet").sourceEntityId()).isEqualTo("car");
            assertThat(snapshot.status().inputs().get("other").sourceEntityId()).isEqualTo("truck");
            assertThat(snapshot.data().get("position").path("publicationSequence").longValue()).isEqualTo(40);
            assertThat(runtime.advance(new ProgressControl("fleet", "v1", "unknown", 50)).changedViews()).isEmpty();
            var unmapped = runtime.snapshot("mapped", "unknown").orElseThrow();
            assertThat(unmapped.version()).isZero();
            assertThat(unmapped.status().inputs().get("fleet").state()).isEqualTo("unmapped");
        }
    }

    @Test
    void untrackedFeedOffsetsNeverImplyEntityGapsOrCompleteness() {
        try (var runtime = new ViewCoordinator(IdentityFixtures.configuration(10, 10, 10))) {
            runtime.apply(IdentityFixtures.event(40));
            runtime.apply(IdentityFixtures.parse("fleet", "trip-1", "other-car", 41, "position", "{}"));
            runtime.apply(IdentityFixtures.event(42));
            var status = runtime.snapshot("latest", "car").orElseThrow().status().inputs().get("fleet");
            assertThat(status.completeness()).isEqualTo("unknown");
            assertThat(status.missingRanges()).isEmpty();
            assertThat(status.observedThrough()).isNull();
            assertThat(runtime.advance(new ProgressControl("fleet", "trip-1", "car", 42)).reason()).isEqualTo("progressUntracked");
        }
    }

    static ViewStatus.InputStatus input(ViewCoordinator runtime) {
        return runtime.snapshot("mixed", "car").orElseThrow().status().inputs().get("fleet");
    }
}
