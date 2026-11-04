package io.zooglass.v2;

import io.zooglass.ZooGlassApplication;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class EntityMappingFunctionalTests {
    @TempDir
    Path directory;
    private static final JsonMapper JSON = new JsonMapper();

    @Test
    void realSourcesConvergeAndRestoreTargetReceiptsAndHttpProvenance() throws Exception {
        Path config = directory.resolve("config.json");
        Files.writeString(config, JSON.writeValueAsString(EntityMappingTests.configuration("sqlite")));
        JsonNode receipt;
        JsonNode snapshot;
        try (var client = HttpClient.newHttpClient()) {
            try (var service = start(config)) {
                int port = port(service);
                try (var source = new PublicationTestClient(client, port)) {
                    source.send(envelope("orders", "order-42", 900));
                    source.send(envelope("stock", "reservation-7", 7));
                    receipt = source.send(envelope("payments", "payment-9", 2));
                    assertThat(receipt.path("status").asText()).isEqualTo("committed");
                    assertThat(receipt.path("targets")).isEqualTo(JSON.readTree("""
                            [{"viewId":"summary","entityId":"order-42","status":"accepted","reason":null,"changedFields":["payment"],"fields":[{"field":"payment","status":"accepted","reason":null,"changed":true}]},
                             {"viewId":"detail","entityId":"payment-9","status":"accepted","reason":null,"changedFields":["payment"],"fields":[{"field":"payment","status":"accepted","reason":null,"changed":true}]}]
                            """));
                    var unknown = source.send(envelope("payments", "unmapped", 1));
                    assertThat(unknown.at("/targets/0/reason").asText()).isEqualTo("unknownEntityMapping");
                    assertThat(unknown.at("/targets/1/status").asText()).isEqualTo("accepted");
                }
                snapshot = read(client, port, "summary/order-42");
                assertThat(snapshot.path("data").size()).isEqualTo(3);
                assertThat(snapshot.at("/provenance/payment/sourceEntityId").asText()).isEqualTo("payment-9");
                assertThat(snapshot.at("/data/order/publicationSequence").longValue()).isEqualTo(900);
                assertThat(read(client, port, "detail/payment-9").at("/data/payment/publicationSequence").longValue()).isEqualTo(2);
            }
            try (var service = start(config)) {
                int port = port(service);
                assertThat(read(client, port, "summary/order-42")).isEqualTo(snapshot);
                try (var source = new PublicationTestClient(client, port)) {
                    var retry = source.send(envelope("payments", "payment-9", 2));
                    assertThat(retry.path("status").asText()).isEqualTo("duplicate");
                    assertThat(retry.path("version")).isEqualTo(receipt.path("version"));
                    assertThat(retry.path("targets")).isEqualTo(receipt.path("targets"));
                    assertThat(retry.path("changedViews").isEmpty()).isTrue();
                    var delayed = source.send(envelope("payments", "payment-9", 1));
                    assertThat(delayed.path("changedViews").isEmpty()).isTrue();
                    assertThat(delayed.at("/targets/0/status").asText()).isEqualTo("accepted");
                    assertThat(delayed.at("/targets/0/changedFields").isEmpty()).isTrue();
                }
                assertThat(read(client, port, "summary/order-42")).isEqualTo(snapshot);
            }
        }
    }

    private static String envelope(String source, String entity, long sequence) {
        return """
                {"sourceId":"%s","epoch":"v1","sourceEntityId":"%s","publicationSequence":%d,
                 "type":"updated","payload":{"value":"ready"}}
                """.formatted(source, entity, sequence);
    }

    private ConfigurableApplicationContext start(Path config) {
        return new SpringApplicationBuilder(ZooGlassApplication.class).run("--server.port=0",
                "--spring.main.banner-mode=off", "--zooglass.v2.config=" + config.toUri(),
                "--zooglass.v2.database=" + directory.resolve("state.db"));
    }

    private static int port(ConfigurableApplicationContext service) {
        return ((WebServerApplicationContext) service).getWebServer().getPort();
    }

    private static JsonNode read(HttpClient client, int port, String path) throws Exception {
        var reply = client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/v2/views/" + path))
                .GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(reply.statusCode()).isEqualTo(200);
        return JSON.readTree(reply.body());
    }
}
