package io.zooglass.access;

import io.zooglass.ZooGlassApplication;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.tomcat.TomcatWebServer;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import tools.jackson.databind.json.JsonMapper;

import javax.net.ssl.SSLContext;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.*;

/** Uses normal production configuration: no replacement admission beans or direct coordinator writes. */
class ProtectedDeploymentTests {
    @TempDir static Path directory;
    private static PolicyTlsFixture policy;
    private static SSLContext previousTrust;
    private static HttpClient http;
    private static final JsonMapper JSON = new JsonMapper();
    private static final String OPERATOR = "synthetic-operator-token-0123456789";
    private static final AtomicBoolean revoked = new AtomicBoolean();
    private static final AtomicInteger calls = new AtomicInteger();

    @BeforeAll
    static void prepare() throws Exception {
        policy = new PolicyTlsFixture(directory);
        previousTrust = SSLContext.getDefault();
        SSLContext.setDefault(policy.trust);
        http = HttpClient.newBuilder().sslContext(policy.trust).version(HttpClient.Version.HTTP_1_1).build();
        policy.handle("/decision", exchange -> {
            try (exchange) {
                assertThat(exchange.getRequestHeaders().getFirst("Authorization")).isEqualTo("Bearer service-secret");
                var request = JSON.readTree(exchange.getRequestBody());
                assertThat(request.path("tenant").asText()).isEqualTo("tenant-a");
                calls.incrementAndGet();
                boolean deny = revoked.get() && request.at("/credential/value").asText().equals("first");
                byte[] reply = (deny ? "{\"decision\":\"deny\"}"
                        : "{\"decision\":\"allow\",\"subject\":\"operator\",\"lifetimeMillis\":1000}")
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, reply.length);
                exchange.getResponseBody().write(reply);
            }
        });
    }

    @AfterAll
    static void stop() {
        if (http != null) http.close();
        if (previousTrust != null) SSLContext.setDefault(previousTrust);
        if (policy != null) policy.close();
    }

    @Test
    void refusesActuatorRemappingThatCouldExposePolicyCredentials() {
        assertThatThrownBy(() -> {
            try (var ignored = start("memory", "tenant-a",
                    "--management.endpoints.web.exposure.include=env",
                    "--management.endpoints.web.path-mapping.env=health",
                    "--management.endpoint.env.show-values=always")) {}
        }).hasRootCauseMessage("Protected deployment does not allow management endpoint remapping");
        assertThatThrownBy(() -> {
            try (var ignored = start("memory", "tenant-a",
                    "--management.endpoints.web.base-path=/actuator/health")) {}
        }).hasRootCauseMessage("Protected deployment requires management base path /actuator");
    }

    @Test
    void refusesNativeForwardingEvenWithTheExplicitNoneStrategy() {
        for (String property : java.util.List.of("protocol-header", "remote-ip-header")) {
            assertThatThrownBy(() -> {
                try (var ignored = start("memory", "tenant-a",
                        "--server.tomcat.remoteip." + property + "=X-Forwarded-Proto")) {}
            }).hasRootCauseMessage("Protected deployment does not allow Tomcat remote-IP settings");
        }
    }

    @Test
    void operatorCanRegisterAViewThroughTheIsolatedInterface() throws Exception {
        try (var service = start("memory")) {
            String definition = """
                    {"id":"operator-defined","fields":{"score":
                     {"sourceId":"match-feed","type":"score.updated","mode":"latestBySequence"}}}
                    """;
            assertThat(define("http://127.0.0.1:" + operatorPort(service), OPERATOR, definition)).isEqualTo(201);
            assertThat(get("https://localhost:" + viewerPort(service) + "/views/operator-defined/42", "healthy")
                    .statusCode()).isEqualTo(200);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    @Timeout(45)
    void isolatedProducersAndFreshDecisionsAcrossRevocationAndRestart(String storage) throws Exception {
        revoked.set(false);
        long version;
        try (var service = start(storage)) {
            int viewer = viewerPort(service);
            int operator = operatorPort(service);
            assertThat(get("http://127.0.0.1:" + operator + "/actuator/health", OPERATOR).statusCode()).isEqualTo(200);
            for (String token : new String[] {"first", "wrong", ""}) {
                assertThat(get("http://127.0.0.1:" + operator + "/actuator/health", token).statusCode()).isEqualTo(403);
            }
            assertThat(get("http://127.0.0.1:" + operator + "/views/match/42", OPERATOR).statusCode()).isEqualTo(403);
            for (String path : new String[] {"/events", "/progress", "/facts/retire", "/actuator/health"}) {
                assertThat(get("https://localhost:" + viewer + path, OPERATOR).statusCode()).isEqualTo(403);
            }
            String definition = """
                    {"id":"match","fields":{"score":
                     {"sourceId":"match-feed","type":"score.updated","mode":"latestBySequence"}}}
                    """;
            assertThat(define("https://localhost:" + viewer, OPERATOR, definition)).isEqualTo(403);
            assertThat(define("http://127.0.0.1:" + operator, "first", definition)).isEqualTo(403);
            assertThat(define("http://127.0.0.1:" + operator, OPERATOR, definition)).isEqualTo(409);
            for (String path : new String[] {"/events", "/progress", "/facts/retire"}) {
                try (var socket = connect("ws://127.0.0.1:" + operator + path, OPERATOR)) {
                    assertThat(socket.closed.isDone()).isFalse();
                }
                assertThatThrownBy(() -> connect("ws://127.0.0.1:" + operator + path, "first"))
                        .hasCauseInstanceOf(WebSocketHandshakeException.class);
                assertThatThrownBy(() -> connect("wss://localhost:" + viewer + path, OPERATOR))
                        .hasCauseInstanceOf(WebSocketHandshakeException.class);
            }
            try (var source = connect("ws://127.0.0.1:" + operator + "/events", OPERATOR);
                    var first = connect("wss://localhost:" + viewer + "/views/live", "first");
                    var healthy = connect("wss://localhost:" + viewer + "/views/live", "healthy")) {
                source.send("""
                        {"sourceId":"match-feed","epoch":"run","sourceEntityId":"42",
                         "publicationSequence":1,"type":"score.updated","payload":{"home":1}}
                        """);
                var receipt = source.next();
                assertThat(receipt.path("status").asText()).as(receipt.toString()).isEqualTo(storage.equals("sqlite") ? "committed" : "applied");
                first.subscribe("match", "42");
                first.next();
                version = first.next().path("version").longValue();
                assertThat(version).isPositive();
                healthy.subscribe("match", "42");
                healthy.next();
                assertThat(healthy.next().path("version").longValue()).isEqualTo(version);
                revoked.set(true);
                assertThat(first.closed.get(4, TimeUnit.SECONDS)).isEqualTo(1008);
                assertThat(get("https://localhost:" + viewer + "/views/match/42", "first").statusCode()).isEqualTo(403);
                assertThatThrownBy(() -> connect("wss://localhost:" + viewer + "/views/live", "first"))
                        .hasCauseInstanceOf(WebSocketHandshakeException.class);
                assertThat(get("https://localhost:" + viewer + "/views/match/42", "healthy").statusCode()).isEqualTo(200);
                service.close();
                healthy.closed.get(4, TimeUnit.SECONDS);
            }
        }
        int before = calls.get();
        try (var service = start(storage)) {
            int viewer = viewerPort(service);
            assertThat(get("https://localhost:" + viewer + "/views/match/42", "first").statusCode()).isEqualTo(403);
            try (var healthy = connect("wss://localhost:" + viewer + "/views/live", "healthy")) {
                healthy.subscribe("match", "42");
                healthy.next();
                var recovered = healthy.next();
                assertThat(recovered.path("version").longValue()).isEqualTo(storage.equals("sqlite") ? version : 0);
                if (storage.equals("sqlite")) assertThat(recovered.at("/data/score/home").asInt()).isEqualTo(1);
                else assertThat(recovered.path("data")).isEmpty();
            }
            assertThat(calls.get() - before).isGreaterThanOrEqualTo(3);
        }
        if (storage.equals("sqlite")) {
            assertThatThrownBy(() -> start(storage, "tenant-b"))
                    .hasRootCauseMessage("Database tenant does not match the configured tenant");
        }
    }

    private ConfigurableApplicationContext start(String storage) throws Exception {
        return start(storage, "tenant-a");
    }

    private ConfigurableApplicationContext start(String storage, String tenant, String... overrides) throws Exception {
        Path config = directory.resolve(storage + ".json");
        Files.writeString(config, """
                {"contractVersion":2,"storage":"%s","maxStreams":10,"identityWindow":10,"maxHistoryEntries":10,
                 "sources":[{"id":"match-feed","epoch":"run"}],
                 "views":[{"id":"match","fields":{"score":
                   {"sourceId":"match-feed","type":"score.updated","mode":"latestBySequence"}}}]}
                """.formatted(storage));
        var arguments = new java.util.ArrayList<>(java.util.List.of(
                "--server.port=0", "--spring.main.banner-mode=off", "--server.ssl.enabled=true",
                "--server.ssl.key-store=" + directory.resolve("policy.p12").toUri(),
                "--server.ssl.key-store-password=test-password", "--server.ssl.key-store-type=PKCS12",
                "--server.forward-headers-strategy=none", "--zooglass.access.mode=applicationPolicy",
                "--zooglass.access.tenant=" + tenant, "--zooglass.access.origin=" + AdmissionBoundaryTests.ORIGIN,
                "--zooglass.access.policy-url=" + policy.settings("/decision", Duration.ofSeconds(1), 8).endpoint(),
                "--zooglass.access.service-token=service-secret", "--zooglass.access.operator-port=0",
                "--zooglass.access.operator-token=" + OPERATOR, "--zooglass.config=" + config.toUri(),
                "--zooglass.database=" + directory.resolve(storage + ".sqlite")));
        arguments.addAll(java.util.List.of(overrides));
        return new SpringApplicationBuilder(ZooGlassApplication.class).run(arguments.toArray(String[]::new));
    }

    private int viewerPort(ConfigurableApplicationContext service) {
        return ((WebServerApplicationContext) service).getWebServer().getPort();
    }

    private int operatorPort(ConfigurableApplicationContext service) {
        var server = (TomcatWebServer) ((WebServerApplicationContext) service).getWebServer();
        for (var connector : server.getTomcat().getService().findConnectors()) {
            if (!connector.getSecure()) {
                assertThat(connector.getProperty("address").toString()).contains("127.0.0.1");
                return connector.getLocalPort();
            }
        }
        throw new AssertionError("No operator listener");
    }

    private HttpResponse<String> get(String address, String token) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(address)).timeout(Duration.ofSeconds(4));
        if (!token.isEmpty()) request.header("Authorization", "Bearer " + token);
        return http.send(request.GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private int define(String origin, String token, String definition) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(origin + "/views"))
                .timeout(Duration.ofSeconds(4)).header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(definition)).build();
        return http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
    }

    private AdmissionSocket connect(String address, String token) {
        return new AdmissionSocket(http, URI.create(address), Map.of("Authorization", "Bearer " + token));
    }
}
