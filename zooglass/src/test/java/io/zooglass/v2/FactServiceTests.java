package io.zooglass.v2;

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
import static io.zooglass.v2.FactFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;

class FactServiceTests {
    @TempDir Path directory;
    private static final JsonMapper JSON = new JsonMapper();

    @Test
    @Timeout(60)
    void sourceAndRetirementSocketsExposeCommittedCollectionsOverHttp() throws Exception {
        var config = directory.resolve("views.json");
        Files.writeString(config, JSON.writeValueAsString(configuration("sqlite", 10, false)));
        try (var app = new SpringApplicationBuilder(ZooGlassApplication.class).run("--server.port=0",
                "--spring.main.banner-mode=off", "--zooglass.v2.config=" + config.toUri(),
                "--zooglass.v2.database=" + directory.resolve("state.db"));
                var http = HttpClient.newHttpClient()) {
            int port = ((WebServerApplicationContext) app).getWebServer().getPort();
            try (var source = new PublicationTestClient(http, port);
                    var retirements = new PublicationTestClient(http, port, "/v2/facts/retire")) {
                assertThat(retirements.send("{}").path("reason").asText()).isEqualTo("invalidFactRetirement");
                var unknown = source.send(JSON.writeValueAsString(event(2, 1, 2, "revise", "{}")));
                assertThat(unknown.path("reason").asText()).isEqualTo("unknownFact");
                assertThat(unknown.at("/targets/0/fields/0/field").asText()).isEqualTo("goals");
                assertThat(source.send(JSON.writeValueAsString(event(1, 1, 1, "create", "{}"))).path("status").asText())
                        .isEqualTo("committed");
                var correction = source.send(JSON.writeValueAsString(event(2, 1, 2, "revise", "{}")));
                assertThat(correction.at("/targets/0/fields/0/reason").asText()).isEqualTo("factImmutable");
                assertThat(correction.at("/targets/1/status").asText()).isEqualTo("accepted");
                var control = JSON.writeValueAsString(retire("corrected", 2));
                assertThat(retirements.send(control).path("status").asText()).isEqualTo("committed");
                var retry = retirements.send(control);
                assertThat(retry.path("kind").asText()).isEqualTo("factRetirement");
                assertThat(retry.path("status").asText()).isEqualTo("unchanged");
                var response = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/v2/views/corrected/game"))
                        .GET().build(), HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);
                var snapshot = JSON.readTree(response.body());
                assertThat(snapshot.at("/data/goals").isArray()).isTrue();
                assertThat(snapshot.at("/data/goals")).isEmpty();
                assertThat(snapshot.at("/status/fields/goals/facts/minimumBirthSequence").longValue()).isEqualTo(2);
                assertThat(source.send(JSON.writeValueAsString(event(2, 1, 2, "revise", "{}"))).path("status").asText())
                        .isEqualTo("duplicate");
            }
        }
    }
}
