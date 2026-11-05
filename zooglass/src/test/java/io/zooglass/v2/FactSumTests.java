package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.util.List;
import static io.zooglass.v2.FactFixtures.scores;

import static io.zooglass.v2.FactFixtures.event;
import static io.zooglass.v2.FactFixtures.snapshot;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class FactSumTests {
    @TempDir Path directory;

    private static Publication points(long sequence, long birth, long revision, String number) {
        return event(sequence, birth, revision, revision == 1 ? "create" : "revise", "{\"points\":" + number + "}");
    }

    private static void score(ViewCoordinator service, String view, String expected) {
        assertThat(snapshot(service, view).data().get("score").decimalValue()).isEqualByComparingTo(expected);
    }

    @Test
    void withdrawalAndRetriesPreserveEachViewsScoreAcrossRestart() {
        var config = scores("sqlite");
        String db = directory.resolve("scores.db").toString();
        var first = points(1, 1, 1, "0.1");
        try (var service = new ViewCoordinator(config, db)) {
            service.apply(first);
            service.apply(points(2, 2, 1, "0.2"));
            score(service, "corrected", "0.3");
            service.apply(points(3, 1, 2, "0.125"));
            score(service, "corrected", "0.325");
            service.apply(event(4, 1, 3, "retract", "{}"));
        }
        try (var service = new ViewCoordinator(config, db)) {
            assertThat(service.apply(first).status()).isEqualTo("duplicate");
            service.apply(points(5, 1, 2, "0.125"));
            score(service, "original", "0.3");
            score(service, "corrected", "0.2");
            assertThat(snapshot(service, "corrected").data().get("goals")).hasSize(1);
            service.retire(new FactRetirement("corrected", "game", List.of("goals", "score"), 3));
            score(service, "corrected", "0");
            assertThat(snapshot(service, "corrected").data().get("goals")).isEmpty();
        }
    }

    @Test
    void sameScoreAfterRestartDoesNotReportAValueChange() {
        var config = scores("sqlite");
        String db = directory.resolve("unchanged.db").toString();
        try (var service = new ViewCoordinator(config, db)) {
            service.apply(points(1, 1, 1, "1.00"));
        }
        try (var service = new ViewCoordinator(config, db)) {
            var outcome = service.apply(points(2, 1, 2, "1e0"));
            assertThat(outcome.targets().getLast().changedFields()).containsExactly("goals");
            score(service, "corrected", "1");
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"{}", "{\"points\":null}", "{\"points\":\"1\"}", "{\"points\":[]}"})
    void invalidContributionRollsBackCollectionAndReceipt(String payload) {
        try (var service = new ViewCoordinator(scores("memory"))) {
            var before = snapshot(service, "original");
            var rejection = service.apply(event(1, 1, 1, "create", payload));
            assertThat(rejection.reason()).isEqualTo("invalidNumericContribution");
            assertThat(rejection.targets().getFirst().fields().getFirst().field()).isEqualTo("score");
            assertThat(snapshot(service, "original")).isEqualTo(before);
            assertThat(service.apply(points(1, 1, 1, "1")).status()).isEqualTo("applied");
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"1e38", "1e1000", "1e-1000", "1e-19", "12345678901234567890123456789012345678.1"})
    void excessivePrecisionScaleOrExponentRejectsThePublication(String number) {
        try (var service = new ViewCoordinator(scores("memory"))) {
            assertThat(service.apply(points(1, 1, 1, number)).reason()).isEqualTo("numericRange");
            assertThat(snapshot(service, "corrected").version()).isZero();
        }
    }

    @Test
    void overflowOnAdditionOrRemovalRollsBackEveryField() {
        String maximum = "9".repeat(38);
        try (var service = new ViewCoordinator(scores("memory"))) {
            service.apply(points(1, 1, 1, "-1"));
            service.apply(points(2, 2, 1, maximum));
            service.apply(points(3, 3, 1, "1"));
            var before = snapshot(service, "corrected");
            score(service, "corrected", maximum);

            assertThat(service.apply(points(4, 4, 1, "1")).reason()).isEqualTo("numericRange");
            assertThat(service.apply(event(4, 1, 2, "retract", "{}")).reason()).isEqualTo("numericRange");
            var retirement = new FactRetirement("corrected", "game", List.of("goals", "score"), 2);
            assertThat(service.retire(retirement).reason()).isEqualTo("numericRange");
            assertThat(snapshot(service, "corrected")).isEqualTo(before);
            assertThat(service.apply(points(4, 4, 1, "-1")).status()).isEqualTo("applied");
        }
    }

    @Test
    void restartDetectsAnIncorrectTotalEvenIfBothStoredCopiesAgree() throws Exception {
        var config = scores("sqlite");
        var db = directory.resolve("corrupt.db");
        try (var service = new ViewCoordinator(config, db.toString())) {
            service.apply(points(1, 1, 1, "1e-18"));
            score(service, "corrected", "0.000000000000000001");
        }
        ProgressFailureTests.execute(db, """
                UPDATE views SET state=json_set(state,'$.data.score',9,'$.candidates.score.match.value',9)
                WHERE view='corrected'
                """);
        assertThatThrownBy(() -> new ViewCoordinator(config, db.toString())).isInstanceOf(IllegalStateException.class);
    }
}
