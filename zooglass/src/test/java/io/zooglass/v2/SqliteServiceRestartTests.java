package io.zooglass.v2;

import io.zooglass.ZooGlassApplication;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteServiceRestartTests {
    @TempDir
    Path directory;

    @Test
    void configuredServiceRestoresHttpSnapshotsAndAcknowledgesSocketRetries() throws Exception {
        var json = new JsonMapper();
        Path config = directory.resolve("views.json");
        Files.writeString(config, json.writeValueAsString(SqliteRecoveryTests.configuration()));
        long version;

        try (var client = HttpClient.newHttpClient()) {
            try (var service = start(config)) {
                int port = ((WebServerApplicationContext) service).getWebServer().getPort();
                try (var source = new PublicationTestClient(client, port)) {
                    var committed = source.send(IdentityFixtures.envelope(1, "{\"value\":1}"));
                    assertThat(committed.path("status").asText()).isEqualTo("committed");
                    version = committed.path("version").longValue();
                }
            }
            try (var service = start(config)) {
                int port = ((WebServerApplicationContext) service).getWebServer().getPort();
                var request = HttpRequest.newBuilder(
                        URI.create("http://localhost:" + port + "/v2/views/latest/car")).GET().build();
                var response = client.send(request, HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);
                assertThat(json.readTree(response.body()).path("version").longValue()).isEqualTo(version);

                try (var source = new PublicationTestClient(client, port)) {
                    var retry = source.send(IdentityFixtures.envelope(1, "{\"value\":1.0}"));
                    assertThat(retry.path("reason").asText()).isEqualTo("alreadyCommitted");
                    assertThat(retry.path("version").longValue()).isEqualTo(version);
                    var next = source.send(IdentityFixtures.envelope(2, "{\"value\":2}"));
                    assertThat(next.path("status").asText()).isEqualTo("committed");
                    assertThat(next.path("version").longValue()).isEqualTo(version + 1);
                }
            }
        }
    }

    private ConfigurableApplicationContext start(Path config) {
        return new SpringApplicationBuilder(ZooGlassApplication.class).run(
                "--server.port=0",
                "--spring.main.banner-mode=off",
                "--zooglass.v2.config=" + config.toUri(),
                "--zooglass.v2.database=" + directory.resolve("state.sqlite"));
    }
}
