package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.ZooGlassApplication;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.servlet.context.ServletWebServerApplicationContext;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

class ClientRecoveryAcceptanceTests {
    private static final JsonMapper JSON = new JsonMapper();

    @TempDir Path directory;

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    @Timeout(90)
    void viewerRecoversMissedChangesThenSubscribesAcrossServiceRestart(String storage)
            throws Exception {
        Path config = directory.resolve("views.json");
        Files.writeString(
                config, JSON.writeValueAsString(FactFixtures.configuration(storage, 10, false)));

        try (var http = HttpClient.newHttpClient()) {
            JsonNode beforeRestart;
            JsonNode floorOnly;
            try (var service = start(config)) {
                int port = service.getWebServer().getPort();
                try (var source = new PublicationTestClient(http, port);
                        var control = new PublicationTestClient(http, port, "/facts/retire")) {
                    beforeRestart = disconnectAndCatchUp(http, port, source, control);
                    retire(control, "unplayed", 5);
                    floorOnly = readBaseline(http, port, "unplayed");
                    assertThat(floorOnly.path("version").longValue()).isPositive();
                    assertThat(floorOnly.path("data").isObject()).isTrue();
                    assertThat(floorOnly.path("data")).isEmpty();
                    assertThat(floorOnly.at("/status/inputs/match/state").asText())
                            .isEqualTo("notObserved");
                    assertThat(
                                    floorOnly
                                            .at("/status/fields/goals/facts/minimumBirthSequence")
                                            .intValue())
                            .isEqualTo(5);
                }
            }

            try (var service = start(config)) {
                int port = service.getWebServer().getPort();
                for (String entity : List.of("game", "unplayed")) {
                    var recovered = readBaseline(http, port, entity);
                    if (storage.equals("sqlite")) {
                        assertThat(recovered)
                                .isEqualTo(entity.equals("game") ? beforeRestart : floorOnly);
                    } else {
                        assertThat(recovered.path("version").isIntegralNumber()).isTrue();
                        assertThat(recovered.path("version").longValue()).isZero();
                        assertThat(recovered.path("data").isObject()).isTrue();
                        assertThat(recovered.path("data")).isEmpty();
                        assertThat(recovered.at("/status/inputs/match/state").asText())
                                .isEqualTo("notObserved");
                    }
                }
            }
        }
    }

    @Test
    @Timeout(30)
    void returningViewerReceivesAcceptedHistoryAfterPublicationIdentityExpires() throws Exception {
        Path config = directory.resolve("views.json");
        Files.writeString(
                config, JSON.writeValueAsString(IdentityFixtures.configuration(10, 1, 2)));
        try (var service = start(config);
                var http = HttpClient.newHttpClient();
                var source = new PublicationTestClient(http, service.getWebServer().getPort())) {
            int port = service.getWebServer().getPort();
            assertThat(
                            source.send(IdentityFixtures.envelope(1, "{\"value\":1}"))
                                    .path("status")
                                    .asText())
                    .isEqualTo("applied");
            try (var viewer = new PublicationTestClient(http, port, "/views/live")) {
                var before = subscribe(viewer, "history", "car");
                assertThat(before.at("/publicationSequences/position"))
                        .isEqualTo(JSON.readTree("[1]"));
            }
            var second = source.send(IdentityFixtures.envelope(2, "{\"value\":2}"));
            assertThat(second.path("status").asText()).isEqualTo("applied");
            var retry = source.send(IdentityFixtures.envelope(1, "{\"value\":1}"));
            assertThat(retry.path("reason").asText()).isEqualTo("outsideRetention");
            var overflow = source.send(IdentityFixtures.envelope(3, "{\"value\":3}"));
            assertThat(overflow.path("reason").asText()).isEqualTo("historyLimit");
            try (var viewer = new PublicationTestClient(http, port, "/views/live")) {
                var after = subscribe(viewer, "history", "car");
                assertThat(after.at("/publicationSequences/position"))
                        .isEqualTo(JSON.readTree("[1,2]"));
                assertThat(after.at("/data/position"))
                        .isEqualTo(JSON.readTree("[{\"value\":1},{\"value\":2}]"));
            }
        }
    }

    private static JsonNode disconnectAndCatchUp(
            HttpClient http, int port, PublicationTestClient source, PublicationTestClient control)
            throws Exception {
        publish(source, 1, 1, 1, "create", "A");
        publish(source, 2, 2, 1, "create", "B");
        var previous = readBaseline(http, port, "game");
        assertThat(previous.at("/data/goals")).hasSize(2);
        assertThat(previous.at("/data/goals/1/payload/scorer").asText()).isEqualTo("B");

        publish(source, 3, 2, 2, "revise", "C");
        retire(control, "game", 2);

        try (var viewer = new PublicationTestClient(http, port, "/views/live")) {
            var baseline = subscribe(viewer, "corrected", "game");
            assertThat(baseline.path("version").longValue())
                    .isGreaterThan(previous.path("version").longValue());
            assertThat(baseline.at("/data/goals")).hasSize(1);
            assertThat(baseline.at("/data/goals/0/birthSequence").intValue()).isEqualTo(2);
            assertThat(baseline.at("/data/goals/0/payload/scorer").asText()).isEqualTo("C");
            assertThat(baseline.at("/status/fields/goals/facts/minimumBirthSequence").intValue())
                    .isEqualTo(2);

            var receipt = publish(source, 4, 2, 3, "revise", "D");
            var next = viewer.nextMessage();
            assertThat(next.path("version")).isEqualTo(receipt.path("version"));
            assertThat(next.path("version").longValue())
                    .isGreaterThan(baseline.path("version").longValue());
            assertThat(next.at("/data/goals/0/payload/scorer").asText()).isEqualTo("D");
            return next;
        }
    }

    private static JsonNode publish(
            PublicationTestClient source,
            long sequence,
            long birth,
            long revision,
            String operation,
            String scorer)
            throws Exception {
        var event =
                FactFixtures.event(
                        sequence,
                        birth,
                        revision,
                        operation,
                        JSON.createObjectNode().put("scorer", scorer).toString());
        var receipt = source.send(JSON.writeValueAsString(event));
        assertThat(receipt.path("status").asText()).isIn("applied", "committed");
        return receipt;
    }

    private static void retire(PublicationTestClient control, String entity, long floor)
            throws Exception {
        var command = new FactRetirement("corrected", entity, List.of("goals"), floor);
        assertThat(control.send(JSON.writeValueAsString(command)).path("status").asText())
                .isIn("applied", "committed");
    }

    private static JsonNode readBaseline(HttpClient http, int port, String entity)
            throws Exception {
        try (var viewer = new PublicationTestClient(http, port, "/views/live")) {
            return subscribe(viewer, "corrected", entity);
        }
    }

    private static JsonNode subscribe(PublicationTestClient viewer, String view, String entity)
            throws Exception {
        var ack =
                viewer.send(
                        """
                        {"action":"subscribe","viewId":"%s","entityId":"%s"}
                        """
                                .formatted(view, entity));
        assertThat(ack.path("type").asText()).isEqualTo("subscribed");
        assertThat(ack.path("recovery").asText()).isEqualTo("freshSnapshot");
        var snapshot = viewer.nextMessage();
        assertThat(snapshot.path("type").asText()).isEqualTo("view-update");
        assertThat(snapshot.path("viewId").asText()).isEqualTo(view);
        assertThat(snapshot.path("entityId").asText()).isEqualTo(entity);
        return snapshot;
    }

    private ServletWebServerApplicationContext start(Path config) {
        return (ServletWebServerApplicationContext)
                new SpringApplicationBuilder(ZooGlassApplication.class)
                        .run(
                                "--server.port=0",
                                "--zooglass.config=" + config.toUri(),
                                "--zooglass.database=" + directory.resolve("state.db"));
    }
}
