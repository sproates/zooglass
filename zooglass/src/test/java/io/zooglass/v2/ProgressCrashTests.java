package io.zooglass.v2;

import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import tools.jackson.databind.json.JsonMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.assertj.core.api.Assertions.*;

class ProgressCrashTests {
    @TempDir Path directory;
    private static final JsonMapper JSON = new JsonMapper();

    @ParameterizedTest
    @EnumSource(CrashBoundaryDriver.Boundary.class)
    @Timeout(120)
    void controlCommitAndLatePoliciesSurviveActualProcessDeath(CrashBoundaryDriver.Boundary boundary) throws Exception {
        Files.writeString(directory.resolve("views.json"), JSON.writeValueAsString(ProgressTests.configuration("sqlite")));
        boolean committed = boundary == CrashBoundaryDriver.Boundary.AFTER_COMMIT || boundary == CrashBoundaryDriver.Boundary.AFTER_ACK;
        String watermark = JSON.writeValueAsString(ProgressTests.watermark(42));
        try (var http = HttpClient.newHttpClient()) {
            try (var service = new CrashServiceProcess(directory, boundary);
                    var source = new PublicationTestClient(http, service.port());
                    var progress = new PublicationTestClient(http, service.port(), "/v2/progress")) {
                if (boundary == CrashBoundaryDriver.Boundary.AFTER_ACK) {
                    assertThat(progress.send("{}").path("reason").asText()).isEqualTo("invalidProgress");
                    assertThat(progress.send(data(40)).path("reason").asText()).isEqualTo("invalidProgress");
                    assertThat(source.send(watermark).path("reason").asText()).isEqualTo("invalidEnvelope");
                }
                source.send(data(40)); source.send(data(42));
                if (boundary == CrashBoundaryDriver.Boundary.AFTER_ACK) {
                    var acknowledgement = progress.send(watermark);
                    assertThat(acknowledgement.path("kind").asText()).isEqualTo("watermark");
                    assertThat(acknowledgement.path("version").longValue()).isEqualTo(3);
                } else {
                    service.arm(); progress.publish(watermark); service.awaitBoundary(boundary);
                }
                service.kill(); progress.assertDisconnectedWithoutReply(); source.assertDisconnectedWithoutReply();
            }
            try (var service = new CrashServiceProcess(directory, CrashBoundaryDriver.Boundary.AFTER_ACK);
                    var source = new PublicationTestClient(http, service.port());
                    var progress = new PublicationTestClient(http, service.port(), "/v2/progress")) {
                var response = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + service.port() + "/v2/views/mixed/car"))
                        .GET().build(), HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);
                var snapshot = JSON.readTree(response.body());
                assertThat(snapshot.path("version").longValue()).isEqualTo(committed ? 3 : 2);
                assertThat(snapshot.at("/status/inputs/fleet/missingRanges/0/status").asText()).isEqualTo(committed ? "confirmed" : "provisional");
                assertThat(snapshot.at("/data/latest/publicationSequence").longValue()).isEqualTo(42);
                var retry = progress.send(watermark);
                assertThat(retry.path("status").asText()).isEqualTo(committed ? "duplicate" : "committed");
                assertThat(retry.path("version").longValue()).isEqualTo(3);
                var late = source.send(data(41));
                assertThat(late.path("status").asText()).isEqualTo("committed");
                assertThat(late.at("/targets/0/fields/2/reason").asText()).isEqualTo("behindWatermark");
                assertThat(late.at("/targets/1/status").asText()).isEqualTo("rejected");
                assertThat(source.send(data(41)).path("targets")).isEqualTo(late.path("targets"));
                assertThat(progress.send(watermark).path("version").longValue()).isEqualTo(3);
            }
        }
    }

    private static String data(long sequence) { return JSON.writeValueAsString(ProgressTests.event(sequence)); }
}
