package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Real source socket with bounded replies and fragmented-message assembly. */
final class PublicationTestClient implements AutoCloseable {

    private static final JsonMapper JSON = new JsonMapper();
    private final LinkedBlockingQueue<String> replies = new LinkedBlockingQueue<>();
    private final WebSocket socket;
    private final CompletableFuture<Void> disconnected = new CompletableFuture<>();

    PublicationTestClient(HttpClient http, int port) {
        this(http, port, "/events");
    }

    PublicationTestClient(HttpClient http, int port, String endpoint) {
        socket =
                http.newWebSocketBuilder()
                        .buildAsync(
                                URI.create("ws://localhost:" + port + endpoint),
                                new WebSocket.Listener() {
                                    private final StringBuilder pending = new StringBuilder();

                                    @Override
                                    public void onOpen(WebSocket connection) {
                                        connection.request(1);
                                    }

                                    @Override
                                    public CompletionStage<?> onClose(
                                            WebSocket connection, int status, String reason) {
                                        disconnected.complete(null);
                                        return null;
                                    }

                                    @Override
                                    public void onError(WebSocket connection, Throwable failure) {
                                        disconnected.complete(null);
                                    }

                                    @Override
                                    public CompletionStage<?> onText(
                                            WebSocket connection, CharSequence text, boolean last) {
                                        pending.append(text);
                                        if (last) {
                                            replies.add(pending.toString());
                                            pending.setLength(0);
                                        }
                                        connection.request(1);
                                        return null;
                                    }
                                })
                        .orTimeout(10, TimeUnit.SECONDS)
                        .join();
    }

    JsonNode send(String text) throws InterruptedException {
        publish(text);
        return nextMessage();
    }

    JsonNode nextMessage() throws InterruptedException {
        String reply = replies.poll(5, TimeUnit.SECONDS);
        assertThat(reply).isNotNull();
        return JSON.readTree(reply);
    }

    void publish(String text) {
        socket.sendText(text, true).orTimeout(10, TimeUnit.SECONDS).join();
    }

    void assertDisconnectedWithoutReply() throws Exception {
        disconnected.get(10, TimeUnit.SECONDS);
        assertThat(replies).isEmpty();
    }

    @Override
    public void close() {
        socket.abort();
    }
}
