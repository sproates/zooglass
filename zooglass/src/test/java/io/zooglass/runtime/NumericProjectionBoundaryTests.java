package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;

class NumericProjectionBoundaryTests {
    @TempDir Path directory;

    @ParameterizedTest
    @ValueSource(
            strings = {
                "0.123456789012345678",
                "99999999999999999999.123456789012345678",
                "2147483648",
                "-2147483648",
                "9223372036854775808",
                "-9223372036854775808",
                "99999999999999999999999999999999999999",
                "1e37",
                "-1e37",
                "0e2147483647"
            })
    void numericBoundariesSurviveRecoveryWithoutFalseValueChanges(String number) {
        String database = directory.resolve("score.db").toString();
        var configuration = FactFixtures.scores("sqlite");
        String payload = "{\"points\":" + number + "}";

        try (var service = new ViewCoordinator(configuration, database)) {
            var result = service.apply(FactFixtures.event(1, 1, 1, "create", payload));
            assertThat(result.status()).isEqualTo("committed");
            assertThat(
                            FactFixtures.snapshot(service, "corrected")
                                    .data()
                                    .get("score")
                                    .decimalValue())
                    .isEqualByComparingTo(number);
        }

        try (var service = new ViewCoordinator(configuration, database)) {
            var result = service.apply(FactFixtures.event(2, 1, 2, "revise", payload));
            assertThat(result.status()).isEqualTo("committed");
            assertThat(result.targets().getLast().changedFields()).doesNotContain("score");
            assertThat(
                            FactFixtures.snapshot(service, "corrected")
                                    .data()
                                    .get("score")
                                    .decimalValue())
                    .isEqualByComparingTo(number);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"100e2147483647", "1e-2147483647"})
    void extremeExponentsAreRejectedWithoutAdmittingThePublication(String number) {
        try (var service = new ViewCoordinator(FactFixtures.scores("memory"))) {
            var result =
                    service.apply(
                            FactFixtures.event(1, 1, 1, "create", "{\"points\":" + number + "}"));
            assertThat(result.reason()).isEqualTo("numericRange");
            assertThat(FactFixtures.snapshot(service, "corrected").version()).isZero();
            assertThat(
                            service.apply(FactFixtures.event(1, 1, 1, "create", "{\"points\":1}"))
                                    .status())
                    .isEqualTo("applied");
        }
    }
}
