package io.zooglass.v2;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Real source socket with bounded replies and fragmented-message assembly. */
final class PublicationTestClient implements AutoCloseable {
    private static final JsonMapper JSON = new JsonMapper();
    private final LinkedBlockingQueue<String> replies = new LinkedBlockingQueue<>();
    private final WebSocket socket;

    PublicationTestClient(HttpClient http, int port) {
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
        return JSON.readTree(reply);
    }

    @Override
    public void close() { socket.abort(); }
}
