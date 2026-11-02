package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "zooglass.v2.config=classpath:v2-views-test.json")
class V2FunctionalTests {
    @LocalServerPort
    private int port;
    private final JsonMapper json = new JsonMapper();

    @Test
    void sourceReconnectRetryAndConflictsHaveExplicitOutcomesAndConsistentSnapshots() throws Exception {
        try (var http = HttpClient.newHttpClient()) {
            assertThat(read(http, "/v2/views/latest/car").path("data").isEmpty()).isTrue();
            long receipt;
            try (var source = new Source(http)) {
                assertThat(source.send("{}").path("reason").asText()).isEqualTo("invalidEnvelope");
                assertThat(source.send(envelope(40, "{\"value\":40}")).path("status").asText()).isEqualTo("applied");
                source.send(envelope(42, "{\"value\":42}"));
                JsonNode late = source.send(envelope(41, "{\"a\":1,\"b\":2}"));
                receipt = late.path("version").longValue();
                assertThat(late.path("changedViews")).extracting(JsonNode::asText).containsExactly("history", "arrival");
            }
            JsonNode before = read(http, "/v2/views/arrival/car");
            try (var reconnected = new Source(http)) {
                JsonNode retry = reconnected.send(envelope(41, "{\"b\":2.0,\"a\":1.00}"));
                assertThat(retry.path("status").asText()).isEqualTo("duplicate");
                assertThat(retry.path("version").longValue()).isEqualTo(receipt);
                assertThat(reconnected.send(envelope(41, "{\"a\":99}")).path("reason").asText()).isEqualTo("identityConflict");
                assertThat(reconnected.send(envelope(50, "{}")).path("reason").asText()).isEqualTo("historyLimit");
                // Failed admission must not advance the retention floor beyond 40.
                assertThat(reconnected.send(envelope(40, "{\"value\":40}")).path("status").asText()).isEqualTo("duplicate");
            }
            assertThat(read(http, "/v2/views/arrival/car")).isEqualTo(before);
            assertThat(read(http, "/v2/views/latest/car").at("/data/position/publicationSequence").longValue()).isEqualTo(42);
            assertThat(read(http, "/v2/views/history/car").at("/data/position"))
                    .extracting(node -> node.path("publicationSequence").longValue()).containsExactly(40L, 41L, 42L);
            var legacy = http.send(HttpRequest.newBuilder(url("/views/latest/car")).GET().build(), HttpResponse.BodyHandlers.ofString());
            assertThat(legacy.statusCode()).isEqualTo(404);
        }
    }

    private String envelope(int sequence, String payload) {
        return """
                {"sourceId":"fleet","epoch":"trip-1","sourceEntityId":"car",
                 "publicationSequence":%d,"type":"position","payload":%s}
                """.formatted(sequence, payload);
    }

    private URI url(String path) {
        return URI.create("http://localhost:" + port + path);
    }

    private JsonNode read(HttpClient http, String path) throws Exception {
        var reply = http.send(HttpRequest.newBuilder(url(path)).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(reply.statusCode()).isEqualTo(200);
        return json.readTree(reply.body());
    }

    private final class Source implements AutoCloseable {
        private final LinkedBlockingQueue<String> replies = new LinkedBlockingQueue<>();
        private final WebSocket socket;

        Source(HttpClient http) {
            socket = http.newWebSocketBuilder().buildAsync(URI.create("ws://localhost:" + port + "/v2/events"),
                    new WebSocket.Listener() {
                        private final StringBuilder pending = new StringBuilder();

                        @Override
                        public void onOpen(WebSocket connection) { connection.request(1); }

                        @Override
                        public CompletionStage<?> onText(WebSocket connection, CharSequence text, boolean last) {
                            pending.append(text);
                            if (last) {
                                replies.add(pending.toString());
                                pending.setLength(0);
                            }
                            connection.request(1);
                            return null;
                        }
                    }).join();
        }

        JsonNode send(String text) throws InterruptedException {
            socket.sendText(text, true).join();
            String reply = replies.poll(5, TimeUnit.SECONDS);
            assertThat(reply).isNotNull();
            return json.readTree(reply);
        }

        @Override
        public void close() { socket.abort(); }
    }
}
