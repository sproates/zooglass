package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.ZooGlassApplication;
import io.zooglass.runtime.Publication;
import io.zooglass.runtime.ViewCoordinator;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocketHandshakeException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

class ViewerAdmissionTests {

    @TempDir static Path directory;
    private static PolicyTlsFixture policy;
    private static ConfigurableApplicationContext service;
    private static HttpClient client;
    private static int port;
    private static final JsonMapper JSON = new JsonMapper();
    private static final AtomicReference<Function<JsonNode, String>> decision = new AtomicReference<>();
    private static final String ALLOW = "{\"decision\":\"allow\",\"subject\":\"operator\",\"lifetimeMillis\":5000}";

    @TestConfiguration(proxyBeanMethods = false)
    static class ProtectedFixture {
        @Bean
        @Primary
        AdmissionAccess protectedAdmission() {
            var settings = policy.settings("/decision", Duration.ofSeconds(3), 8);
            return new AdmissionAccess(new ApplicationPolicyAccess("tenant-a",
                    new HttpsPolicyClient(settings, policy.trust), System::nanoTime),
                    "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
        }
    }

    @BeforeAll
    static void start() throws Exception {
        policy = new PolicyTlsFixture(directory);
        policy.handle("/decision", exchange -> {
            try (exchange) {
                var request = JSON.readTree(exchange.getRequestBody());
                byte[] body = decision.get().apply(request).getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            }
        });
        service = new SpringApplicationBuilder(ZooGlassApplication.class, ProtectedFixture.class).run(
                "--server.port=0", "--spring.main.banner-mode=off", "--server.ssl.enabled=true",
                "--server.ssl.key-store=" + directory.resolve("policy.p12").toUri(),
                "--server.ssl.key-store-password=test-password", "--server.ssl.key-store-type=PKCS12",
                "--server.forward-headers-strategy=none");
        port = ((WebServerApplicationContext) service).getWebServer().getPort();
        client = HttpClient.newBuilder().sslContext(policy.trust).build();
    }

    @BeforeEach
    void resetPolicy() {
        decision.set(request -> ALLOW);
    }

    @AfterAll
    static void stop() {
        if (client != null) client.close();
        if (service != null) service.close();
        if (policy != null) policy.close();
    }

    @Test
    void bothSnapshotRoutesDecideBeforeLookupAndDoNotCacheProtectedResponses() throws Exception {
        publish("snapshot", 1);
        for (String path : new String[] {"/views/match/snapshot", "/views?viewId=match&entityId=snapshot"}) {
            decision.set(request -> {
                assertThat(request.path("tenant").asText()).isEqualTo("tenant-a");
                assertThat(request.path("resource").path("viewId").asText()).isEqualTo("match");
                assertThat(request.path("resource").path("entityId").asText()).isEqualTo("snapshot");
                return ALLOW;
            });
            var response = get(path, "viewer-token");
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
            assertThat(JSON.readTree(response.body()).path("data").has("score")).isTrue();
        }
        for (var failure : Map.of("deny", 403, "unauthenticated", 401, "broken", 503).entrySet()) {
            decision.set(request -> "{\"decision\":\"" + failure.getKey() + "\"}");
            for (String path : new String[] {"/views/match/snapshot", "/views?viewId=unknown&entityId=secret"}) {
                var response = get(path, "viewer-token");
                assertThat(response.statusCode()).isEqualTo(failure.getValue());
                assertThat(response.body()).isEmpty();
            }
        }
        decision.set(request -> ALLOW);
        assertThat(get("/views/unknown/secret", "viewer-token").statusCode()).isEqualTo(404);
        assertThat(get("/views?viewId=&entityId=secret", "viewer-token").statusCode()).isEqualTo(400);
        assertThat(get("/views/match/snapshot", null).statusCode()).isEqualTo(401);
    }

    @Test
    void realHandshakeChecksCredentialsOriginAndPolicyAvailability() {
        for (var failure : Map.of("deny", 403, "unauthenticated", 401, "broken", 503).entrySet()) {
            decision.set(request -> "{\"decision\":\"" + failure.getKey() + "\"}");
            refused(Map.of("Authorization", "Bearer viewer-token"), failure.getValue());
        }
        decision.set(request -> ALLOW);
        refused(Map.of(), 401);
        refused(Map.of("Authorization", "Bearer viewer-token", "Origin", "https://wrong.example"), 403);
        refused(Map.of("Cookie", "session=opaque"), 403);
        try (var socket = socket(Map.of("Cookie", "session=opaque", "Origin", AdmissionBoundaryTests.ORIGIN))) {
            assertThat(socket.closed.isDone()).isFalse();
        }
    }

    @Test
    void inactiveDenialSendsNoBaselineAndSuccessfulRepeatGetsFreshBaseline() throws Exception {
        try (var socket = socket(Map.of("Authorization", "Bearer viewer-token"))) {
            decision.set(request -> "{\"decision\":\"deny\"}");
            socket.subscribe("match", "subscription");
            assertThat(socket.next().path("code").asText()).isEqualTo("accessDenied");
            decision.set(request -> ALLOW);
            socket.subscribe("match", "subscription");
            assertThat(socket.next().path("type").asText()).isEqualTo("subscribed");
            assertThat(socket.next().path("version").longValue()).isZero();
            publish("subscription", 1);
            long version = socket.next().path("version").longValue();
            socket.subscribe("match", "subscription");
            assertThat(socket.next().path("type").asText()).isEqualTo("subscribed");
            assertThat(socket.next().path("version").longValue()).isEqualTo(version);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"deny", "broken"})
    void failedRepeatClosesAllSubscriptionsButLeavesOtherViewersWorking(String failure) throws Exception {
        try (var first = socket(Map.of("Authorization", "Bearer first"));
                var other = socket(Map.of("Authorization", "Bearer other"))) {
            for (String entity : new String[] {"one-" + failure, "two-" + failure}) {
                first.subscribe("match", entity);
                first.next();
                first.next();
            }
            other.subscribe("match", "one-" + failure);
            other.next();
            other.next();
            decision.set(request -> "first".equals(request.path("credential").path("value").asText())
                    ? "{\"decision\":\"" + failure + "\"}" : ALLOW);
            first.subscribe("match", "one-" + failure);
            assertThat(first.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
            publish("one-" + failure, 1);
            assertThat(other.next().path("data").has("score")).isTrue();
        }
    }

    @Test
    void subjectCannotChangeOnAnExistingSocket() throws Exception {
        try (var socket = socket(Map.of("Authorization", "Bearer viewer-token"))) {
            decision.set(request -> ALLOW.replace("operator", "someone-else"));
            socket.subscribe("match", "42");
            assertThat(socket.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1008);
        }
    }

    @Test
    void viewerCannotReachOperatorOrManagementEndpointsAndPlaintextIsNotAuthenticated() throws Exception {
        for (String path : new String[] {"/events", "/progress", "/facts/retire", "/actuator/health",
                "/views/../events", "/views/%2e%2e/events"}) {
            assertThat(get(path, "viewer-token").statusCode()).isNotEqualTo(200);
        }
        var registration = HttpRequest.newBuilder(URI.create("https://localhost:" + port + "/views"))
                .header("Authorization", "Bearer viewer-token")
                .POST(HttpRequest.BodyPublishers.ofString("{}")).build();
        assertThat(client.send(registration, HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
        var plain = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/views/match/42"))
                .timeout(Duration.ofSeconds(2)).header("Authorization", "Bearer synthetic")
                .header("X-Forwarded-Proto", "https").build();
        try {
            assertThat(client.send(plain, HttpResponse.BodyHandlers.ofString()).statusCode()).isNotEqualTo(200);
        } catch (java.io.IOException expectedTlsRefusal) {
            // TLS listeners may reject a plaintext request without an HTTP response.
        }
    }

    @Test
    void waitingForPolicyDoesNotBlockPublicationAndBaselineUsesCurrentState() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var socket = socket(Map.of("Authorization", "Bearer viewer-token"))) {
            decision.set(request -> {
                entered.countDown();
                try {
                    if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("Policy was not released");
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError(interrupted);
                }
                return ALLOW;
            });
            socket.subscribe("match", "during-policy");
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                CompletableFuture.runAsync(() -> publish("during-policy", 1)).get(1, TimeUnit.SECONDS);
            } finally {
                release.countDown();
            }
            assertThat(socket.next().path("type").asText()).isEqualTo("subscribed");
            assertThat(socket.next().path("data").has("score")).isTrue();
        }
    }

    private HttpResponse<String> get(String path, String token) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("https://localhost:" + port + path))
                .timeout(Duration.ofSeconds(5));
        if (token != null) request.header("Authorization", "Bearer " + token);
        return client.send(request.GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    private AdmissionSocket socket(Map<String, String> headers) {
        return new AdmissionSocket(client, URI.create("wss://localhost:" + port + "/views/live"), headers);
    }

    private void refused(Map<String, String> headers, int status) {
        assertThatThrownBy(() -> socket(headers)).hasCauseInstanceOf(WebSocketHandshakeException.class)
                .satisfies(failure -> assertThat(((WebSocketHandshakeException) failure.getCause())
                        .getResponse().statusCode()).isEqualTo(status));
    }

    private void publish(String entity, long sequence) {
        service.getBean(ViewCoordinator.class).apply(new Publication("match-feed", "run", entity,
                sequence, "score.updated", JSON.readTree("{\"home\":1}")));
    }
}
