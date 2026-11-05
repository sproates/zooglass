package io.zooglass.runtime;

import static io.zooglass.runtime.FactFixtures.configuration;
import static io.zooglass.runtime.FactFixtures.event;
import static io.zooglass.runtime.FactFixtures.retire;
import static io.zooglass.runtime.FactFixtures.snapshot;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;

class FactCrashTests {

    @TempDir Path directory;

    private static final JsonMapper JSON = new JsonMapper();

    @ParameterizedTest
    @CsvSource({
        "BEFORE_COMMIT,false",
        "AFTER_COMMIT,false",
        "BEFORE_COMMIT,true",
        "AFTER_COMMIT,true",
    })
    @Timeout(120)
    void retractionOrRetirementCommitsItsWholeStateAcrossProcessDeath(
            CrashBoundaryDriver.Boundary boundary, boolean retirement) throws Exception {
        var config = configuration("sqlite", 10, false);
        Files.writeString(directory.resolve("views.json"), JSON.writeValueAsString(config));
        var retraction = event(2, 1, 2, "retract", "{}");
        try (var http = HttpClient.newHttpClient();
                var service = new CrashServiceProcess(directory, boundary);
                var source = new PublicationTestClient(http, service.port());
                var controls = new PublicationTestClient(http, service.port(), "/facts/retire")) {
            assertThat(
                            source.send(JSON.writeValueAsString(event(1, 1, 1, "create", "{}")))
                                    .path("status")
                                    .asText())
                    .isEqualTo("committed");
            service.arm();
            if (retirement) {
                controls.publish(JSON.writeValueAsString(retire("corrected", 2)));
            } else {
                source.publish(JSON.writeValueAsString(retraction));
            }
            service.awaitBoundary(boundary);
            service.kill();
            source.assertDisconnectedWithoutReply();
            controls.assertDisconnectedWithoutReply();
        }
        boolean committed = boundary == CrashBoundaryDriver.Boundary.AFTER_COMMIT;
        try (var service =
                new ViewCoordinator(config, directory.resolve("state.sqlite").toString())) {
            var recovered = snapshot(service, "corrected");
            assertThat(recovered.data().get("goals")).hasSize(committed ? 0 : 1);
            assertThat(recovered.status().fields().get("goals").facts().minimumBirthSequence())
                    .isEqualTo(retirement && committed ? 2 : 1);
            assertThat(recovered.status().fields().get("goals").facts().retainedCount())
                    .isEqualTo(retirement && committed ? 0 : 1);
            if (retirement) {
                assertThat(service.retire(retire("corrected", 2)).status())
                        .isEqualTo(committed ? "unchanged" : "committed");
            } else {
                assertThat(service.apply(retraction).status())
                        .isEqualTo(committed ? "duplicate" : "committed");
            }
            assertThat(snapshot(service, "corrected").data().get("goals")).isEmpty();
        }
    }
}
