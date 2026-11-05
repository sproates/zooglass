package io.zooglass.runtime;

import static io.zooglass.runtime.IdentityFixtures.envelope;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "zooglass.config=classpath:runtime-views-test.json")
class PublicationFunctionalTests {

    @LocalServerPort private int port;

    private static final JsonMapper JSON = new JsonMapper();

    @Test
    void sourceReconnectRetryAndConflictsHaveExplicitOutcomesAndConsistentSnapshots()
            throws Exception {
        try (var http = HttpClient.newHttpClient()) {
            assertThat(read(http, "/views/latest/car").path("data").isEmpty()).isTrue();
            long receipt;
            try (var source = new PublicationTestClient(http, port)) {
                assertThat(source.send("{}").path("reason").asText()).isEqualTo("invalidEnvelope");
                assertThat(source.send(envelope(40, "{\"value\":40}")).path("status").asText())
                        .isEqualTo("applied");
                source.send(envelope(42, "{\"value\":42}"));
                JsonNode late = source.send(envelope(41, "{\"a\":1,\"b\":2}"));
                receipt = late.path("version").longValue();
                assertThat(late.path("changedViews"))
                        .extracting(JsonNode::asText)
                        .containsExactly("history", "arrival");
            }
            JsonNode before = read(http, "/views/arrival/car");
            try (var reconnected = new PublicationTestClient(http, port)) {
                JsonNode retry = reconnected.send(envelope(41, "{\"b\":2.0,\"a\":1.00}"));
                assertThat(retry.path("status").asText()).isEqualTo("duplicate");
                assertThat(retry.path("version").longValue()).isEqualTo(receipt);
                assertThat(reconnected.send(envelope(41, "{\"a\":99}")).path("reason").asText())
                        .isEqualTo("identityConflict");
                assertThat(reconnected.send(envelope(50, "{}")).path("reason").asText())
                        .isEqualTo("historyLimit");
                // Failed admission must not advance the retention floor beyond 40.
                assertThat(reconnected.send(envelope(40, "{\"value\":40}")).path("status").asText())
                        .isEqualTo("duplicate");
            }
            assertThat(read(http, "/views/arrival/car")).isEqualTo(before);
            assertThat(
                            read(http, "/views/latest/car")
                                    .at("/publicationSequences/position/0")
                                    .longValue())
                    .isEqualTo(42);
            assertThat(read(http, "/views/history/car").at("/publicationSequences/position"))
                    .extracting(JsonNode::longValue)
                    .containsExactly(40L, 41L, 42L);
            var legacy =
                    http.send(
                            HttpRequest.newBuilder(url("/v2/views/latest/car")).GET().build(),
                            HttpResponse.BodyHandlers.ofString());
            assertThat(legacy.statusCode()).isEqualTo(404);
        }
    }

    private URI url(String path) {
        return URI.create("http://localhost:" + port + path);
    }

    private JsonNode read(HttpClient http, String path) throws Exception {
        var reply =
                http.send(
                        HttpRequest.newBuilder(url(path)).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
        assertThat(reply.statusCode()).isEqualTo(200);
        return JSON.readTree(reply.body());
    }
}
