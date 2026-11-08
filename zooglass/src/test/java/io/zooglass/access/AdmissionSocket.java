package io.zooglass.access;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

final class AdmissionSocket implements AutoCloseable {

    final CompletableFuture<Integer> closed = new CompletableFuture<>();
    private final LinkedBlockingQueue<String> messages = new LinkedBlockingQueue<>();
    private final WebSocket socket;

    AdmissionSocket(HttpClient client, URI endpoint, Map<String, String> headers) {
        var builder = client.newWebSocketBuilder();
        headers.forEach(builder::header);
        socket = builder.buildAsync(endpoint, new WebSocket.Listener() {
            private final StringBuilder text = new StringBuilder();

            @Override
            public void onOpen(WebSocket ws) {
                ws.request(1);
            }

            @Override
            public CompletionStage<?> onText(WebSocket ws, CharSequence part, boolean last) {
                text.append(part);
                if (last) {
                    messages.add(text.toString());
                    text.setLength(0);
                }
                ws.request(1);
                return null;
            }

            @Override
            public CompletionStage<?> onClose(WebSocket ws, int status, String reason) {
                closed.complete(status);
                return null;
            }

            @Override
            public void onError(WebSocket ws, Throwable error) {
                closed.completeExceptionally(error);
            }
        }).orTimeout(5, TimeUnit.SECONDS).join();
    }

    void subscribe(String view, String entity) {
        socket.sendText(new JsonMapper().writeValueAsString(
                Map.of("action", "subscribe", "viewId", view, "entityId", entity)), true).join();
    }

    void send(String message) { socket.sendText(message, true).join(); }

    JsonNode next() throws Exception {
        String text = messages.poll(5, TimeUnit.SECONDS);
        if (text == null) {
            throw new AssertionError("No view message received");
        }
        return new JsonMapper().readTree(text);
    }

    @Override
    public void close() {
        socket.abort();
    }
}
