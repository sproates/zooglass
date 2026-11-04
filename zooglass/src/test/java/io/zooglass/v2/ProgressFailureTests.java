package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;
import static io.zooglass.v2.ProgressTests.*;
import static org.assertj.core.api.Assertions.*;

class ProgressFailureTests {
    @TempDir Path directory;

    @Test
    void rangeOverflowAndFloorExpiryAreAtomicAndControlStreamsRespectAdmissionLimit() {
        var base = configuration("memory");
        var config = new V2Configuration(2, "memory", 1, 3, 20,
                List.of(new V2Configuration.Source("fleet", "v1", new V2Configuration.Progress("contiguousSequence", 40L, 1L, 1L))), base.views());
        try (var runtime = new ViewCoordinator(config)) {
            runtime.apply(event(42));
            var before = runtime.snapshot("mixed", "car").orElseThrow();
            assertThat(runtime.advance(watermark(40)).reason()).isEqualTo("progressLimit");
            assertThat(runtime.apply(event(44)).reason()).isEqualTo("progressLimit");
            assertThat(runtime.snapshot("mixed", "car").orElseThrow()).isEqualTo(before);
            assertThat(runtime.advance(new ProgressControl("fleet", "v1", "other", 40)).reason()).isEqualTo("streamLimit");
            runtime.apply(event(40));
            runtime.apply(event(43));
            runtime.apply(event(44));
            assertThat(input(runtime).missingRanges().getFirst().status()).isEqualTo("expired");
            assertThat(runtime.apply(event(41)).reason()).isEqualTo("outsideRetention");
            assertThat(runtime.advance(watermark(43)).status()).isEqualTo("applied");
            assertThat(input(runtime).completeness()).isEqualTo("incomplete");
        }
    }

    @Test
    void failedControlWriteDoesNotAdvanceWatermarkOrConsumeItsRetry() throws Exception {
        Path file = directory.resolve("state.db");
        var config = configuration("sqlite");
        try (var runtime = new ViewCoordinator(config, file.toString())) { runtime.apply(event(40)); }
        execute(file, "CREATE TRIGGER refuse_view BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'test'); END");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            assertThatThrownBy(() -> runtime.advance(watermark(42))).isInstanceOf(IllegalStateException.class);
            assertThat(runtime.healthy()).isFalse();
        }
        execute(file, "DROP TRIGGER refuse_view");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            assertThat(input(runtime).watermarkThrough()).isNull();
            assertThat(runtime.advance(watermark(42)).status()).isEqualTo("committed");
            assertThat(runtime.advance(watermark(42)).version()).isEqualTo(2);
        }
    }

    @Test
    void recoveredControlOnlyStreamCanAdmitLateDataAndRetainOriginalControlVersion() {
        Path file = directory.resolve("control.db");
        var config = configuration("sqlite");
        try (var runtime = new ViewCoordinator(config, file.toString())) { runtime.advance(watermark(42)); }
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            assertThat(runtime.advance(watermark(42)).status()).isEqualTo("duplicate");
            assertThat(runtime.apply(event(40)).status()).isEqualTo("committed");
            assertThat(input(runtime).sourceContractViolated()).isTrue();
            assertThat(runtime.advance(watermark(42)).version()).isEqualTo(1);
        }
    }

    @Test
    void recoveryRejectsCorruptProgressRangesBoundariesAndFieldOutcomes() throws Exception {
        int index = 0;
        for (String damage : List.of(
                "json_remove(state,'$.progress')",
                "json_set(state,'$.progress.receivedThrough',39,'$.progress.received',json('[]'))",
                "json_set(state,'$.progress.received',json('[{\"from\":42,\"through\":42},{\"from\":42,\"through\":43}]'))",
                "json_set(state,'$.progress.observedThrough',900)",
                "json_set(state,'$.progress.watermarkVersion',999)",
                "json_set(state,'$.progress.watermarkThrough',39)",
                "json_set(state,'$.receipts.40.targets[0].fields[0].status','rejected')")) {
            Path file = directory.resolve("corrupt-" + index++ + ".db");
            var config = configuration("sqlite");
            try (var runtime = new ViewCoordinator(config, file.toString())) {
                runtime.apply(event(40)); runtime.apply(event(42)); runtime.advance(watermark(42));
            }
            execute(file, "UPDATE streams SET state=" + damage);
            assertThatThrownBy(() -> new ViewCoordinator(config, file.toString())).as(damage).isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void rejectedLateReceiptCannotRecoverWithAnUnbrokenPromise() throws Exception {
        Path file = directory.resolve("violation.db");
        var config = configuration("sqlite");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            runtime.advance(watermark(42)); runtime.apply(event(40));
        }
        execute(file, "UPDATE streams SET state=json_set(state,'$.progress.sourceContractViolated',json('false'))");
        assertThatThrownBy(() -> new ViewCoordinator(config, file.toString())).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void candidateCannotClaimAnUnreceivedOrBeforeStartSequence() throws Exception {
        for (int sequence : List.of(39, 41)) {
            Path file = directory.resolve("candidate-" + sequence + ".db");
            var config = configuration("sqlite");
            try (var runtime = new ViewCoordinator(config, file.toString())) {
                runtime.apply(event(40)); runtime.apply(event(42));
            }
            execute(file, "UPDATE views SET state=json_set(state,'$.data.position.publicationSequence'," + sequence
                    + ",'$.candidates.position.fleet.value.publicationSequence'," + sequence + ") WHERE view='strict'");
            assertThatThrownBy(() -> new ViewCoordinator(config, file.toString())).isInstanceOf(IllegalStateException.class);
        }
    }

    static void execute(Path file, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file); var statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
