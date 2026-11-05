package io.zooglass;

import static org.assertj.core.api.Assertions.assertThat;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Real socket client for the strategy acceptance tests, including fragmented messages. */
final class StrategySocketClient implements AutoCloseable {

    private final LinkedBlockingQueue<String> messages = new LinkedBlockingQueue<>();
    private final ObjectMapper json;
    private final WebSocket socket;

    StrategySocketClient(HttpClient http, String url, ObjectMapper json) {
        this.json = json;
        socket =
                http.newWebSocketBuilder()
                        .connectTimeout(Duration.ofSeconds(5))
                        .buildAsync(
                                URI.create(url),
                                new WebSocket.Listener() {
                                    private final StringBuilder pending = new StringBuilder();

                                    @Override
                                    public void onOpen(WebSocket webSocket) {
                                        webSocket.request(1);
                                    }

                                    @Override
                                    public CompletionStage<?> onText(
                                            WebSocket webSocket, CharSequence data, boolean last) {
                                        pending.append(data);
                                        if (last) {
                                            messages.add(pending.toString());
                                            pending.setLength(0);
                                        }
                                        webSocket.request(1);
                                        return null;
                                    }
                                })
                        .join();
    }

    void send(Object message) {
        socket.sendText(json.writeValueAsString(message), true).join();
    }

    void subscribe(String view, String entity) throws InterruptedException {
        send(java.util.Map.of("action", "subscribe", "viewId", view, "entityId", entity));
        JsonNode reply = next();
        assertThat(reply.path("type").asText()).isEqualTo("subscribed");
        assertThat(reply.path("viewId").asText()).isEqualTo(view);
        assertThat(reply.path("entityId").asText()).isEqualTo(entity);
    }

    List<JsonNode> throughMarker(String markerView, int marker) throws InterruptedException {
        List<JsonNode> updates = new ArrayList<>();
        while (true) {
            JsonNode message = next();
            assertThat(message.path("type").asText()).isEqualTo("view-update");
            if (message.path("viewId").asText().equals(markerView)) {
                assertThat(message.at("/data/receipt/step").asInt()).isEqualTo(marker);
                return updates;
            }
            updates.add(message);
        }
    }

    private JsonNode next() throws InterruptedException {
        String message = messages.poll(5, TimeUnit.SECONDS);
        assertThat(message).as("expected a complete server message").isNotNull();
        return json.readTree(message);
    }

    @Override
    public void close() {
        socket.abort();
    }
}
