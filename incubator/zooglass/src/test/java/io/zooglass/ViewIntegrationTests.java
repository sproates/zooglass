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
import java.util.concurrent.CompletionStage;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "zooglass.views.config=classpath:views-test.json")
class ViewIntegrationTests {

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void matchingEventsUpdateTheLatestViewReturnedByHttp() throws Exception {
        HttpClient httpClient = HttpClient.newHttpClient();
        WebSocket socket = httpClient.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .buildAsync(URI.create("ws://localhost:" + port + "/events"), new WebSocket.Listener() {
                    @Override
                    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                        return WebSocket.Listener.super.onText(webSocket, data, last);
                    }
                })
                .join();

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
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        HttpResponse<String> response;
        do {
            response = getView(client, viewId, entityId);
            if (response.statusCode() == 200) {
                JsonNode view = objectMapper.readTree(response.body());
                if (view.at("/data/score/home").asText().equals(expectedHomeScore)) {
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
}
