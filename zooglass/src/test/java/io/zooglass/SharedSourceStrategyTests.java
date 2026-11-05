package io.zooglass;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "zooglass.views.config=classpath:views-test.json")
class SharedSourceStrategyTests {

    @LocalServerPort private int port;

    @Autowired private ObjectMapper json;

    @ParameterizedTest(name = "shared feed with runtime definitions: {0}")
    @ValueSource(booleans = {false, true})
    void subscribersSeeIndependentStrategiesAfterEveryPublication(boolean runtime)
            throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            String suffix = runtime ? "runtime" : "startup";
            String latest = runtime ? "acceptance-latest" : "vehicle-live-map";
            String history = runtime ? "acceptance-history" : "vehicle-trip-history";
            String marker = "receipt-" + suffix;
            String entity = "subject-" + suffix;
            String other = "other-" + suffix;
            if (runtime) {
                define(http, latest, "position", "vehicle.location.updated", "latestBySequence");
                define(http, history, "positions", "vehicle.location.updated", "historyBySequence");
            }
            define(http, marker, "receipt", marker, null);

            try (var source = socket(http, "/events");
                    var subject = socket(http, "/views/live");
                    var neighbour = socket(http, "/views/live")) {
                for (String view : List.of(latest, history)) {
                    subject.subscribe(view, entity);
                    neighbour.subscribe(view, other);
                }
                subject.subscribe(marker, "barrier");
                neighbour.subscribe(marker, "barrier");

                JsonNode forty = payload(40, "a");
                JsonNode fortyTwo = payload(42, "c");
                JsonNode fortyOne = payload(41, "b");
                List<JsonNode> expectedHistory = List.of(forty, fortyOne, fortyTwo);

                publish(source, entity, forty);
                barrier(source, marker, 1);
                assertUpdates(
                        subject,
                        marker,
                        1,
                        entity,
                        snapshot(latest, "position", forty),
                        snapshot(history, "positions", List.of(forty)));
                assertUpdates(neighbour, marker, 1, other);

                publish(source, entity, fortyTwo);
                barrier(source, marker, 2);
                assertUpdates(
                        subject,
                        marker,
                        2,
                        entity,
                        snapshot(latest, "position", fortyTwo),
                        snapshot(history, "positions", List.of(forty, fortyTwo)));
                assertUpdates(neighbour, marker, 2, other);

                publish(source, entity, fortyOne);
                barrier(source, marker, 3);
                assertUpdates(
                        subject,
                        marker,
                        3,
                        entity,
                        snapshot(history, "positions", expectedHistory));
                assertUpdates(neighbour, marker, 3, other);

                // Neither an exact duplicate nor conflicting equal sequences produce an update.
                for (JsonNode ignored :
                        List.of(
                                fortyOne,
                                payload(41, "conflict"),
                                payload(42, "conflict"),
                                json.readTree(
                                        "{\"sequence\":42.0,\"label\":\"decimal conflict\"}"))) {
                    publish(source, entity, ignored);
                }
                barrier(source, marker, 4);
                assertUpdates(subject, marker, 4, entity);
                assertUpdates(neighbour, marker, 4, other);

                // The same sequence in another entity is a new fact, not a duplicate.
                JsonNode independent = payload(41, "other entity");
                publish(source, other, independent);
                barrier(source, marker, 5);
                assertUpdates(subject, marker, 5, entity);
                assertUpdates(
                        neighbour,
                        marker,
                        5,
                        other,
                        snapshot(latest, "position", independent),
                        snapshot(history, "positions", List.of(independent)));

                assertThat(read(http, latest, entity).path("data"))
                        .isEqualTo(json.valueToTree(Map.of("position", fortyTwo)));
                assertThat(read(http, history, entity).path("data"))
                        .isEqualTo(json.valueToTree(Map.of("positions", expectedHistory)));
            }
        }
    }

    private void assertUpdates(
            StrategySocketClient client,
            String marker,
            int step,
            String entity,
            JsonNode... expected)
            throws InterruptedException {
        List<JsonNode> messages = client.throughMarker(marker, step);
        assertThat(messages)
                .allSatisfy(
                        message -> assertThat(message.path("entityId").asText()).isEqualTo(entity));
        List<JsonNode> contents =
                messages.stream()
                        .map(
                                message ->
                                        json.<JsonNode>valueToTree(
                                                Map.of(
                                                        "viewId",
                                                        message.path("viewId").asText(),
                                                        "data",
                                                        message.get("data"))))
                        .toList();
        assertThat(contents).containsExactlyInAnyOrder(expected);
    }

    private JsonNode snapshot(String view, String field, Object value) {
        return json.valueToTree(Map.of("viewId", view, "data", Map.of(field, value)));
    }

    private JsonNode payload(int sequence, String label) {
        return json.valueToTree(Map.of("sequence", sequence, "label", label));
    }

    private void publish(StrategySocketClient source, String entity, JsonNode payload) {
        source.send(
                Map.of(
                        "sourceId",
                        "vehicle-feed",
                        "type",
                        "vehicle.location.updated",
                        "entityId",
                        entity,
                        "payload",
                        payload));
    }

    private void barrier(StrategySocketClient source, String marker, int step) {
        // Ordered source messages and each subscriber's FIFO writer put this receipt
        // after every preceding update, including updates that should not exist.
        source.send(
                Map.of(
                        "sourceId",
                        "vehicle-feed",
                        "type",
                        marker,
                        "entityId",
                        "barrier",
                        "payload",
                        Map.of("step", step)));
    }

    private StrategySocketClient socket(HttpClient http, String path) {
        return new StrategySocketClient(http, "ws://localhost:" + port + path, json);
    }

    private void define(HttpClient http, String id, String field, String type, String mode)
            throws Exception {
        var definition = new java.util.LinkedHashMap<String, Object>();
        definition.put("id", id);
        definition.put(
                "fields", Map.of(field, List.of(Map.of("sourceId", "vehicle-feed", "type", type))));
        if (mode != null) {
            definition.put(
                    "ordering", Map.of(field, Map.of("mode", mode, "sequenceField", "sequence")));
        }
        HttpRequest request =
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/views"))
                        .header("Content-Type", "application/json")
                        .POST(
                                HttpRequest.BodyPublishers.ofString(
                                        json.writeValueAsString(definition)))
                        .build();
        assertThat(http.send(request, HttpResponse.BodyHandlers.ofString()).statusCode())
                .isEqualTo(201);
    }

    private JsonNode read(HttpClient http, String view, String entity) throws Exception {
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
        return json.readTree(response.body());
    }
}
