package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "zooglass.views.config=classpath:views-test.json")
class ViewFunctionalTests {

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void matchingEventsUpdateTheLatestViewReturnedByHttp() throws Exception {
        HttpClient httpClient = HttpClient.newHttpClient();
        WebSocket socket = connect(httpClient);

        try {
            assertThat(getView(httpClient, "match", "match-42").statusCode()).isEqualTo(404);

            send(socket, "match-feed", "score.updated", "match-42", "{\"home\":0,\"away\":0}");
            send(socket, "bookmaker", "odds.updated", "match-42", "{\"homeWin\":2.1,\"draw\":3.2}");
            send(socket, "match-feed", "score.updated", "match-42", "{\"home\":1,\"away\":0}");
            send(socket, "match-feed", "score.updated", "match-99", "{\"home\":2,\"away\":1}");
            send(socket, "other-feed", "score.updated", "match-42", "{\"home\":9,\"away\":9}");

            JsonNode view = awaitView(httpClient, "match", "match-42", "1");
            assertThat(view.get("viewId").asText()).isEqualTo("match");
            assertThat(view.get("entityId").asText()).isEqualTo("match-42");
            assertThat(view.at("/data/score/home").asInt()).isEqualTo(1);
            assertThat(view.at("/data/score/away").asInt()).isEqualTo(0);
            assertThat(view.at("/data/odds/homeWin").asDouble()).isEqualTo(2.1);

            JsonNode otherEntity = awaitView(httpClient, "match", "match-99", "2");
            assertThat(otherEntity.at("/data/score/home").asInt()).isEqualTo(2);
            assertThat(otherEntity.get("data").has("odds")).isFalse();
        } finally {
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "test complete").join();
        }
    }

    @Test
    void viewsDefinedOverHttpStartWithEventsReceivedAfterDefinition() throws Exception {
        HttpClient httpClient = HttpClient.newHttpClient();
        WebSocket socket = connect(httpClient);

        try {
            send(socket, "match-feed", "score.updated", "item-before-view", "{\"home\":0}");
            awaitView(httpClient, "match", "item-before-view", "0");

            String definition = objectMapper.writeValueAsString(Map.of(
                    "id", "runtime-items",
                    "fields", Map.of("score", List.of(Map.of(
                            "sourceId", "match-feed",
                            "type", "score.updated")))));
            assertThat(defineView(httpClient, definition).statusCode()).isEqualTo(201);
            assertThat(getView(httpClient, "runtime-items", "item-before-view").statusCode()).isEqualTo(404);

            send(socket, "match-feed", "score.updated", "item-after-view", "{\"home\":1}");
            JsonNode view = awaitView(httpClient, "runtime-items", "item-after-view", "1");
            assertThat(view.at("/data/score/home").asInt()).isEqualTo(1);

            assertThat(defineView(httpClient, definition).statusCode()).isEqualTo(409);
            assertThat(defineView(httpClient, "{\"id\":\"invalid\",\"fields\":{}}").statusCode()).isEqualTo(400);
        } finally {
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "test complete").join();
        }
    }

    @Test
    void liveViewWebSocketAcknowledgesSubscriptionsAndSendsMatchingUpdates() throws Exception {
        HttpClient httpClient = HttpClient.newHttpClient();
        WebSocket eventSocket = connect(httpClient);
        LiveViewClient liveViewClient = connectLiveViewClient(httpClient);

        try {
            liveViewClient.socket().sendText(
                    "{\"action\":\"subscribe\",\"viewId\":\"match\",\"entityId\":\"match-42\"}",
                    true).join();

            JsonNode acknowledgement = objectMapper.readTree(awaitMessage(liveViewClient.messages()));
            assertThat(acknowledgement.get("type").asText()).isEqualTo("subscribed");
            assertThat(acknowledgement.get("viewId").asText()).isEqualTo("match");
            assertThat(acknowledgement.get("entityId").asText()).isEqualTo("match-42");

            send(eventSocket, "match-feed", "score.updated", "match-42", "{\"home\":1,\"away\":0}");

            JsonNode update = objectMapper.readTree(awaitMessage(liveViewClient.messages()));
            assertThat(update.get("type").asText()).isEqualTo("view-update");
            assertThat(update.get("viewId").asText()).isEqualTo("match");
            assertThat(update.get("entityId").asText()).isEqualTo("match-42");
            assertThat(update.at("/data/score/home").asInt()).isEqualTo(1);
            assertThat(update.at("/data/score/away").asInt()).isEqualTo(0);
        } finally {
            liveViewClient.socket().sendClose(WebSocket.NORMAL_CLOSURE, "test complete").join();
            eventSocket.sendClose(WebSocket.NORMAL_CLOSURE, "test complete").join();
        }
    }

    private WebSocket connect(HttpClient httpClient) {
        return httpClient.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .buildAsync(URI.create("ws://localhost:" + port + "/events"), new WebSocket.Listener() {
                    @Override
                    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                        return WebSocket.Listener.super.onText(webSocket, data, last);
                    }
                })
                .join();
    }

    private LiveViewClient connectLiveViewClient(HttpClient httpClient) {
        BlockingQueue<String> messages = new LinkedBlockingQueue<>();
        WebSocket socket = httpClient.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .buildAsync(URI.create("ws://localhost:" + port + "/views/live"), new WebSocket.Listener() {
                    @Override
                    public void onOpen(WebSocket webSocket) {
                        webSocket.request(1);
                    }

                    @Override
                    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                        messages.add(data.toString());
                        webSocket.request(1);
                        return null;
                    }
                })
                .join();
        return new LiveViewClient(socket, messages);
    }

    private static String awaitMessage(BlockingQueue<String> messages) throws InterruptedException {
        String message = messages.poll(5, TimeUnit.SECONDS);
        if (message == null) {
            throw new AssertionError("Timed out waiting for a live view WebSocket message.");
        }
        return message;
    }

    private HttpResponse<String> defineView(HttpClient client, String definition)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + "/views"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(definition))
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> getView(HttpClient client, String viewId, String entityId)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + "/views/" + viewId + "/" + entityId))
                .GET()
                .build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private JsonNode awaitView(HttpClient client, String viewId, String entityId, String expectedHomeScore)
            throws Exception {
        return awaitView(client, viewId, entityId, "/data/score/home", expectedHomeScore);
    }

    private JsonNode awaitView(HttpClient client, String viewId, String entityId, String dataPath, String expectedValue)
            throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        HttpResponse<String> response;
        do {
            response = getView(client, viewId, entityId);
            if (response.statusCode() == 200) {
                JsonNode view = objectMapper.readTree(response.body());
                if (view.at(dataPath).asText().equals(expectedValue)) {
                    return view;
                }
            }
            Thread.sleep(20);
        } while (System.nanoTime() < deadline);

        throw new AssertionError("View did not appear. Last response: " + response.statusCode());
    }

    private static void send(WebSocket socket, String sourceId, String type, String entityId, String payload) {
        String event = "{\"sourceId\":\"" + sourceId + "\",\"type\":\"" + type
                + "\",\"entityId\":\"" + entityId + "\",\"payload\":" + payload + "}";
        socket.sendText(event, true).join();
    }

    private record LiveViewClient(WebSocket socket, BlockingQueue<String> messages) {
    }
}
