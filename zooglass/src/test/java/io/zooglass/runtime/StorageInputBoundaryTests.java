package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

class StorageInputBoundaryTests {
    @TempDir Path directory;

    @Test
    void deepestWirePayloadCanCommitAndRetryAcrossRestart() {
        String file = directory.resolve("state.sqlite").toString();
        String payload = "{\"x\":" + "[".repeat(498) + "0" + "]".repeat(498) + "}";
        String tooDeep = "{\"x\":" + "[".repeat(499) + "0" + "]".repeat(499) + "}";
        assertThatThrownBy(
                        () ->
                                IdentityFixtures.parse(
                                        "fleet", "trip-1", "car", 1, "position", tooDeep))
                .isInstanceOf(RuntimeException.class);
        var event = IdentityFixtures.parse("fleet", "trip-1", "car", 1, "position", payload);
        try (var service = new ViewCoordinator(SqliteRecoveryTests.configuration(), file)) {
            assertThat(service.apply(event).status()).isEqualTo("committed");
            assertThat(service.apply(IdentityFixtures.event(2)).status()).isEqualTo("committed");
        }
        try (var recovered = new ViewCoordinator(SqliteRecoveryTests.configuration(), file)) {
            assertThat(recovered.apply(event).status()).isEqualTo("duplicate");
        }
    }

    @Test
    void refusesUnpairedSurrogatesWithoutConsumingIdentity() {
        String invalid = "\\" + "ud800";
        String low = "\\" + "udc00";
        for (String bad : java.util.List.of(invalid, low)) {
            assertThatThrownBy(
                            () ->
                                    IdentityFixtures.parse(
                                            "fleet", "trip-1", bad, 1, "position", "{}"))
                    .isInstanceOf(IllegalArgumentException.class);
            for (String payload :
                    java.util.List.of("{\"x\":[\"" + bad + "\"]}", "{\"" + bad + "\":1}")) {
                assertThatThrownBy(
                                () ->
                                        IdentityFixtures.parse(
                                                "fleet", "trip-1", "car", 1, "position", payload))
                        .isInstanceOf(IllegalArgumentException.class);
            }
        }
        String file = directory.resolve("unicode.sqlite").toString();
        var valid =
                IdentityFixtures.parse(
                        "fleet", "trip-1", "car🚗", 1, "position", "{\"🚗\":\"🚗\"}");
        try (var service = new ViewCoordinator(SqliteRecoveryTests.configuration(), file)) {
            assertThat(service.apply(valid).status()).isEqualTo("committed");
        }
        try (var recovered = new ViewCoordinator(SqliteRecoveryTests.configuration(), file)) {
            assertThat(recovered.apply(valid).status()).isEqualTo("duplicate");
        }
    }
}
