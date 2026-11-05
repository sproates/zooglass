package io.zooglass.runtime;

import static io.zooglass.runtime.FactFixtures.event;
import static io.zooglass.runtime.FactFixtures.scores;
import static io.zooglass.runtime.FactFixtures.snapshot;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.ZooGlassApplication;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;

import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;

class FactServiceTests {

    @TempDir Path directory;

    private static final JsonMapper JSON = new JsonMapper();

    @Test
    @Timeout(60)
    void sourceAndRetirementSocketsExposeCommittedCollectionsOverHttp() throws Exception {
        var config = directory.resolve("views.json");
        Files.writeString(config, JSON.writeValueAsString(scores("sqlite")));
        try (var app =
                        new SpringApplicationBuilder(ZooGlassApplication.class)
                                .run(
                                        "--server.port=0",
                                        "--spring.main.banner-mode=off",
                                        "--zooglass.config=" + config.toUri(),
                                        "--zooglass.database=" + directory.resolve("state.db"));
                var http = HttpClient.newHttpClient()) {
            int port = ((WebServerApplicationContext) app).getWebServer().getPort();
            try (var source = new PublicationTestClient(http, port);
                    var retirements = new PublicationTestClient(http, port, "/facts/retire")) {
                assertThat(retirements.send("{}").path("reason").asText())
                        .isEqualTo("invalidFactRetirement");
                var unknown =
                        source.send(
                                JSON.writeValueAsString(
                                        event(2, 1, 2, "revise", "{\"points\":2}")));
                assertThat(unknown.path("reason").asText()).isEqualTo("unknownFact");
                assertThat(unknown.at("/targets/0/fields/0/field").asText()).isEqualTo("goals");
                var oversized =
                        source.send(
                                """
                                {"sourceId":"match","epoch":"v1","sourceEntityId":"game","publicationSequence":1,
                                 "type":"goal","fact":{"birthSequence":1,"revision":1,"operation":"create"},
                                 "payload":{"points":100e2147483647}}
                                """);
                assertThat(oversized.path("reason").asText()).isEqualTo("numericRange");
                assertThat(oversized.path("status").asText()).isEqualTo("rejected");
                assertThat(
                                source.send(
                                                JSON.writeValueAsString(
                                                        event(1, 1, 1, "create", "{\"points\":1}")))
                                        .path("status")
                                        .asText())
                        .isEqualTo("committed");
                var correction =
                        source.send(
                                JSON.writeValueAsString(
                                        event(2, 1, 2, "revise", "{\"points\":2}")));
                assertThat(correction.at("/targets/0/fields/0/reason").asText())
                        .isEqualTo("factImmutable");
                assertThat(correction.at("/targets/1/status").asText()).isEqualTo("accepted");
                var control =
                        JSON.writeValueAsString(
                                new FactRetirement(
                                        "corrected",
                                        "game",
                                        java.util.List.of("goals", "score"),
                                        2));
                assertThat(retirements.send(control).path("status").asText())
                        .isEqualTo("committed");
                var retry = retirements.send(control);
                assertThat(retry.path("kind").asText()).isEqualTo("factRetirement");
                assertThat(retry.path("status").asText()).isEqualTo("unchanged");
                var response =
                        http.send(
                                HttpRequest.newBuilder(
                                                URI.create(
                                                        "http://localhost:"
                                                                + port
                                                                + "/views/corrected/game"))
                                        .GET()
                                        .build(),
                                HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);
                var snapshot = JSON.readTree(response.body());
                assertThat(snapshot.at("/data/score").isNumber()).isTrue();
                assertThat(snapshot.at("/data/score").intValue()).isZero();
                assertThat(snapshot.at("/data/goals").isArray()).isTrue();
                assertThat(snapshot.at("/data/goals")).isEmpty();
                assertThat(
                                snapshot.at("/status/fields/goals/facts/minimumBirthSequence")
                                        .longValue())
                        .isEqualTo(2);
                assertThat(
                                source.send(
                                                JSON.writeValueAsString(
                                                        event(2, 1, 2, "revise", "{\"points\":2}")))
                                        .path("status")
                                        .asText())
                        .isEqualTo("duplicate");
            }
        }
    }
}
