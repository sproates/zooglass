package io.zooglass.v2;

import static io.zooglass.v2.IdentityFixtures.envelope;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

class SqliteCrashRecoveryTests {

    private static final JsonMapper JSON = new JsonMapper();

    @TempDir Path directory;

    @ParameterizedTest
    @EnumSource(CrashBoundaryDriver.Boundary.class)
    @Timeout(120)
    void processDeathPreservesExactlyTheCommittedState(CrashBoundaryDriver.Boundary boundary)
            throws Exception {
        Files.writeString(
                directory.resolve("views.json"),
                JSON.writeValueAsString(SqliteRecoveryTests.configuration()));
        boolean committed =
                boundary == CrashBoundaryDriver.Boundary.AFTER_COMMIT
                        || boundary == CrashBoundaryDriver.Boundary.AFTER_ACK;

        try (var http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()) {
            crashAtBoundary(http, boundary);

            // Start another real service against the same database, without republishing.
            try (var recovered =
                            new CrashServiceProcess(
                                    directory, CrashBoundaryDriver.Boundary.AFTER_ACK);
                    var source = new PublicationTestClient(http, recovered.port())) {
                int port = recovered.port();
                assertSnapshot(http, port, "latest", committed ? 3 : 2, committed ? 43 : 42);
                assertSnapshot(http, port, "arrival", committed ? 3 : 2, committed ? 43 : 42);
                assertHistory(
                        http, port, committed ? new Long[] {40L, 42L, 43L} : new Long[] {40L, 42L});

                var old = source.send(envelope(40, "{\"value\":40}"));
                assertThat(old.path("reason").asText())
                        .isEqualTo(committed ? "outsideRetention" : "alreadyCommitted");

                var retry = source.send(envelope(43, "{\"value\":43.0}"));
                assertThat(retry.path("status").asText())
                        .isEqualTo(committed ? "duplicate" : "committed");
                assertThat(retry.path("version").longValue()).isEqualTo(3);
                assertThat(retry.path("targets"))
                        .isEqualTo(
                                JSON.readTree(
                                        """
                                        [{"viewId":"latest","entityId":"car","status":"accepted","reason":null,"changedFields":["position"],"fields":[{"field":"position","status":"accepted","reason":null,"changed":true}]},
                                         {"viewId":"history","entityId":"car","status":"accepted","reason":null,"changedFields":["position"],"fields":[{"field":"position","status":"accepted","reason":null,"changed":true}]},
                                         {"viewId":"arrival","entityId":"car","status":"accepted","reason":null,"changedFields":["position"],"fields":[{"field":"position","status":"accepted","reason":null,"changed":true}]}]
                                        """));
                assertHistory(http, port, 40L, 42L, 43L);

                // New delayed input must use the restored ordering policy and retained floor.
                assertThat(source.send(envelope(41, "{\"value\":41}")).path("version").longValue())
                        .isEqualTo(4);
                assertSnapshot(http, port, "latest", 3, 43);
                assertSnapshot(http, port, "arrival", 4, 41);
                assertHistory(http, port, 40L, 41L, 42L, 43L);

                var conflict = source.send(envelope(43, "{\"value\":999}"));
                assertThat(conflict.path("reason").asText()).isEqualTo("identityConflict");
                assertThat(source.send(envelope(43, "{\"value\":43}")).path("version").longValue())
                        .isEqualTo(3);
                assertSnapshot(http, port, "arrival", 4, 41);
                assertThat(source.send(envelope(44, "{\"value\":44}")).path("version").longValue())
                        .isEqualTo(5);
                assertSnapshot(http, port, "latest", 5, 44);
                assertHistory(http, port, 40L, 41L, 42L, 43L, 44L);
            }
        }
    }

    private void crashAtBoundary(HttpClient http, CrashBoundaryDriver.Boundary boundary)
            throws Exception {
        try (var service = new CrashServiceProcess(directory, boundary);
                var source = new PublicationTestClient(http, service.port())) {
            assertThat(source.send(envelope(40, "{\"value\":40}")).path("status").asText())
                    .isEqualTo("committed");
            assertThat(source.send(envelope(42, "{\"value\":42}")).path("version").longValue())
                    .isEqualTo(2);

            if (boundary == CrashBoundaryDriver.Boundary.AFTER_ACK) {
                var acknowledgement = source.send(envelope(43, "{\"value\":43}"));
                assertThat(acknowledgement.path("status").asText()).isEqualTo("committed");
                assertThat(acknowledgement.path("version").longValue()).isEqualTo(3);
            } else {
                service.arm();
                source.publish(envelope(43, "{\"value\":43}"));
                service.awaitBoundary(boundary);
            }

            service.kill();
            source.assertDisconnectedWithoutReply();
        }
    }

    private void assertSnapshot(HttpClient http, int port, String view, long version, long sequence)
            throws Exception {
        JsonNode snapshot = snapshot(http, port, view);
        assertThat(snapshot.path("version").longValue()).isEqualTo(version);
        assertThat(snapshot.path("provenance"))
                .isEqualTo(
                        JSON.readTree(
                                """
                                {"position":{"sourceId":"fleet","epoch":"trip-1","sourceEntityId":"car"}}
                                """));
        assertThat(snapshot.at("/data/position/publicationSequence").longValue())
                .isEqualTo(sequence);
        assertThat(snapshot.at("/data/position/payload/value").longValue()).isEqualTo(sequence);
    }

    private void assertHistory(HttpClient http, int port, Long... expected) throws Exception {
        assertThat(snapshot(http, port, "history").at("/data/position"))
                .extracting(value -> value.path("publicationSequence").longValue())
                .containsExactly(expected);
    }

    private JsonNode snapshot(HttpClient http, int port, String view) throws Exception {
        var request =
                HttpRequest.newBuilder(
                                URI.create(
                                        "http://127.0.0.1:" + port + "/v2/views/" + view + "/car"))
                        .timeout(Duration.ofSeconds(5))
                        .GET()
                        .build();
        var response = http.send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        return JSON.readTree(response.body());
    }
}
