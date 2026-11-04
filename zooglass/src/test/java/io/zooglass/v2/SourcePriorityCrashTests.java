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

import static org.assertj.core.api.Assertions.assertThat;

class SourcePriorityCrashTests {
    @TempDir Path directory;
    private static final JsonMapper JSON = new JsonMapper();

    @ParameterizedTest
    @EnumSource(CrashBoundaryDriver.Boundary.class)
    @Timeout(120)
    void hiddenCandidatesAndReceiptsCommitTogetherAcrossProcessDeath(CrashBoundaryDriver.Boundary boundary) throws Exception {
        Files.writeString(directory.resolve("views.json"), JSON.writeValueAsString(SourcePriorityTests.configuration("sqlite")));
        boolean committed = boundary == CrashBoundaryDriver.Boundary.AFTER_COMMIT
                || boundary == CrashBoundaryDriver.Boundary.AFTER_ACK;
        try (var http = HttpClient.newHttpClient()) {
            try (var service = new CrashServiceProcess(directory, boundary);
                    var source = new PublicationTestClient(http, service.port())) {
                source.send(envelope("primary", 2));
                source.send(envelope("backup", 900));
                if (boundary == CrashBoundaryDriver.Boundary.AFTER_ACK) {
                    assertThat(source.send(envelope("backup", 901)).path("version").longValue()).isEqualTo(3);
                } else {
                    service.arm();
                    source.publish(envelope("backup", 901));
                    service.awaitBoundary(boundary);
                }
                service.kill();
                source.assertDisconnectedWithoutReply();
            }
            // Inspect both the visible winner and the independently retained hidden candidate before retry.
            try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + directory.resolve("state.sqlite"));
                    var statement = connection.createStatement();
                    var rows = statement.executeQuery("SELECT json_extract(state,'$.candidates.status.backup.value.publicationSequence') FROM views WHERE view='primary-first'")) {
                assertThat(rows.next()).isTrue();
                assertThat(rows.getLong(1)).isEqualTo(committed ? 901 : 900);
            }
            try (var service = new CrashServiceProcess(directory, CrashBoundaryDriver.Boundary.AFTER_ACK);
                    var source = new PublicationTestClient(http, service.port())) {
                assertSnapshot(http, service.port(), "primary-first", "primary", 2, 1);
                assertSnapshot(http, service.port(), "backup-first", "backup", committed ? 901 : 900, committed ? 3 : 2);
                var retry = source.send(envelope("backup", 901));
                assertThat(retry.path("status").asText()).isEqualTo(committed ? "duplicate" : "committed");
                assertThat(retry.path("version").longValue()).isEqualTo(3);
                assertThat(retry.at("/targets/0/changedFields").isEmpty()).isTrue();
                assertThat(retry.at("/targets/1/changedFields/0").asText()).isEqualTo("status");
                assertThat(source.send(envelope("backup", 899)).path("changedViews").isEmpty()).isTrue();
                assertSnapshot(http, service.port(), "backup-first", "backup", 901, 3);
                assertThat(source.send(envelope("primary", 1)).path("changedViews").isEmpty()).isTrue();
                source.send(envelope("primary", 3));
                assertSnapshot(http, service.port(), "primary-first", "primary", 3, 6);
            }
        }
    }

    private static String envelope(String source, long sequence) {
        return """
                {"sourceId":"%s","epoch":"v1","sourceEntityId":"%s","publicationSequence":%d,
                 "type":"updated","payload":{"status":"ready"}}
                """.formatted(source, source.equals("primary") ? "shipment" : "tracking", sequence);
    }

    private static void assertSnapshot(HttpClient http, int port, String view, String source, long sequence, long version) throws Exception {
        var response = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/v2/views/" + view + "/order"))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        var snapshot = JSON.readTree(response.body());
        assertThat(snapshot.path("version").longValue()).isEqualTo(version);
        assertThat(snapshot.at("/data/status/publicationSequence").longValue()).isEqualTo(sequence);
        assertThat(snapshot.at("/provenance/status/sourceId").asText()).isEqualTo(source);
    }
}
