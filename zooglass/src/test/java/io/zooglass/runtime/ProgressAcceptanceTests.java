package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.ZooGlassApplication;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Map;

class ProgressAcceptanceTests {

    private static final JsonMapper JSON = new JsonMapper();

    @TempDir Path directory;

    @Test
    @Timeout(60)
    void publicInterfacesDistinguishDelayedMissingAndSharedFeedSequences() throws Exception {
        var tracked = ProgressTests.configuration("memory");
        var sources = new ArrayList<>(tracked.sources());
        sources.add(new RuntimeConfiguration.Source("shared", "v1"));
        var views = new ArrayList<>(tracked.views());
        views.add(
                new RuntimeConfiguration.View(
                        "latest",
                        Map.of(
                                "position",
                                new RuntimeConfiguration.Field(
                                        "shared", "position", "latestBySequence"))));
        var config = new RuntimeConfiguration(2, "memory", 30, 20, 20, sources, views);
        Path file = directory.resolve("views.json");
        Files.writeString(file, JSON.writeValueAsString(config));

        try (var service =
                        new SpringApplicationBuilder(ZooGlassApplication.class)
                                .run(
                                        "--server.port=0",
                                        "--spring.main.banner-mode=off",
                                        "--zooglass.config=" + file.toUri());
                var http = HttpClient.newHttpClient()) {
            int port = ((WebServerApplicationContext) service).getWebServer().getPort();
            try (var source = new PublicationTestClient(http, port);
                    var progress = new PublicationTestClient(http, port, "/progress")) {
                send(source, data("fleet", "delayed", 40));
                send(source, data("fleet", "delayed", 42));
                var before = read(http, port, "mixed", "delayed");
                assertThat(before.at("/status/inputs/fleet/missingRanges/0/status").asText())
                        .isEqualTo("provisional");
                send(source, data("fleet", "delayed", 41));
                var delayed = read(http, port, "mixed", "delayed");
                assertThat(delayed.at("/status/inputs/fleet/missingRanges").isArray()).isTrue();
                assertThat(delayed.at("/status/inputs/fleet/missingRanges")).isEmpty();
                assertThat(delayed.at("/publicationSequences/latest/0").longValue()).isEqualTo(42);
                assertThat(delayed.at("/publicationSequences/accept"))
                        .extracting(JsonNode::longValue)
                        .containsExactly(40L, 41L, 42L);

                send(source, data("fleet", "missing", 40));
                send(source, data("fleet", "missing", 42));
                var watermark =
                        progress.send(
                                JSON.writeValueAsString(
                                        new ProgressControl("fleet", "v1", "missing", 42)));
                assertThat(watermark.path("status").asText()).isEqualTo("applied");
                var missing = read(http, port, "mixed", "missing");
                assertThat(missing.at("/status/inputs/fleet/completeness").asText())
                        .isEqualTo("incomplete");
                assertThat(missing.at("/status/inputs/fleet/missingRanges/0/status").asText())
                        .isEqualTo("confirmed");
                assertThat(missing.at("/status/inputs/fleet/missingRanges/0/from").longValue())
                        .isEqualTo(41);
                assertThat(missing.at("/status/inputs/fleet/missingRanges/0/through").longValue())
                        .isEqualTo(41);
                assertThat(missing.at("/publicationSequences/latest/0").longValue()).isEqualTo(42);
                assertThat(missing.at("/publicationSequences/accept"))
                        .extracting(JsonNode::longValue)
                        .containsExactly(40L, 42L);

                send(source, data("shared", "A", 40));
                send(source, data("shared", "B", 41));
                send(source, data("shared", "A", 42));
                var shared = read(http, port, "latest", "A");
                assertThat(shared.at("/status/inputs/shared/completeness").asText())
                        .isEqualTo("unknown");
                assertThat(shared.at("/status/inputs/shared/missingRanges").isArray()).isTrue();
                assertThat(shared.at("/status/inputs/shared/missingRanges")).isEmpty();
                assertThat(shared.at("/publicationSequences/position/0").longValue()).isEqualTo(42);
                assertThat(
                                read(http, port, "latest", "B")
                                        .at("/publicationSequences/position/0")
                                        .longValue())
                        .isEqualTo(41);
                assertThat(read(http, port, "mixed", "missing")).isEqualTo(missing);
            }
        }
    }

    private static void send(PublicationTestClient source, String event) throws Exception {
        assertThat(source.send(event).path("status").asText()).isEqualTo("applied");
    }

    private static String data(String source, String entity, long sequence) {
        return JSON.writeValueAsString(
                IdentityFixtures.parse(source, "v1", entity, sequence, "position", "{}"));
    }

    private static JsonNode read(HttpClient http, int port, String view, String entity)
            throws Exception {
        var request =
                HttpRequest.newBuilder(
                                URI.create(
                                        "http://localhost:"
                                                + port
                                                + "/views/"
                                                + view
                                                + "/"
                                                + entity))
                        .GET()
                        .build();
        var response = http.send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        return JSON.readTree(response.body());
    }
}
