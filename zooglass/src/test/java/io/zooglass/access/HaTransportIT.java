package io.zooglass.access;

import io.zooglass.ZooGlassApplication;
import io.zooglass.runtime.PostgresTestDatabase;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
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
import java.util.*;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.*;

/** Runs the actual HTTP, WebSocket, policy and PostgreSQL boundaries with independent candidate connections. */
class HaTransportIT {
    static final String PROBE = "synthetic-probe-secret-0123456789012345";
    static final String OPERATOR = "synthetic-operator-secret-012345678901";
    static final String MEDIA = "application/vnd.zooglass.ha-v1+json";
    static final JsonMapper JSON = new JsonMapper();
    @TempDir Path directory;
    private HttpClient http;

    @Test
    @Timeout(90)
    void protectedTransportPreservesBaselineAndReceiptAcrossStandbyTakeover() throws Exception {
        var previous = SSLContext.getDefault();
        try (var database = new PostgresTestDatabase(); var tls = new PolicyTlsFixture(directory)) {
            SSLContext.setDefault(tls.trust);
            http = HttpClient.newBuilder().sslContext(tls.trust).version(HttpClient.Version.HTTP_1_1).build();
            var revoke = new java.util.concurrent.atomic.AtomicBoolean();
            tls.handle("/decision", exchange -> {
                try (exchange) {
                    var input = JSON.readTree(exchange.getRequestBody());
                    var deny = (revoke.get() && "read".equals(input.path("operation").asText()))
                            || "denied".equals(input.at("/credential/value").asText())
                            || "secret".equals(input.at("/resource/viewId").asText());
                    byte[] body = (deny ? "{\"decision\":\"deny\"}" :
                            "{\"decision\":\"allow\",\"subject\":\"viewer\",\"lifetimeMillis\":5000}").getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, body.length);
                    exchange.getResponseBody().write(body);
                }
            });
            try (var first = start(database, tls, true)) {
                var a = ports(first);
                awaitReady(a);
                try (var second = start(database, tls, true)) {
                    var b = ports(second);
                    assertThat(get(b.viewer + "/ha/ready", PROBE, MEDIA).statusCode()).isEqualTo(503);
                    assertThat(get(b.viewer + "/views/match/42", "viewer", MEDIA).statusCode()).isEqualTo(503);
                    assertThat(get(a.viewer + "/ha/ready", "viewer", MEDIA).statusCode()).isEqualTo(401);
                    assertThat(get(a.operator + "/ha/ready", OPERATOR, MEDIA).statusCode()).isEqualTo(403);
                    assertThat(get(a.viewer + "/views/match/42", "viewer", "*/*").statusCode()).isEqualTo(406);
                    assertThat(get(a.viewer + "/views/unknown/42", "denied", MEDIA).statusCode()).isEqualTo(403);
                    assertThat(get(a.viewer + "/events", OPERATOR, MEDIA).statusCode()).isEqualTo(403);
                    String publication = """
                            {"sourceId":"feed","epoch":"run","sourceEntityId":"42","publicationSequence":1,"type":"updated","payload":{"score":3}}
                            """;
                    String subscribe = """
                            {"action":"subscribe","subscription":"1","viewId":"match","entityId":"42"}
                            """;
                    String original;
                    String incarnation;
                    try (var source = socket(a.source, OPERATOR); var viewer = socket(a.live, "viewer")) {
                        var hello = source.next();
                        assertThat(hello.path("kind").asText()).isEqualTo("hello");
                        original = hello.path("generation").asText();
                        incarnation = hello.path("incarnation").asText();
                        assertThat(viewer.next().path("incarnation").asText()).isEqualTo(incarnation);
                        viewer.send(subscribe);
                        assertThat(viewer.next().path("kind").asText()).isEqualTo("subscribed");
                        assertThat(viewer.next().path("kind").asText()).isEqualTo("baseline");
                        viewer.send(subscribe.replace("\"1\"", "\"2\"").replace("match", "secret"));
                        assertThat(viewer.next()).isEqualTo(JSON.readTree("{\"error\":\"accessDenied\",\"subscription\":\"2\"}"));
                        source.send(publication);
                        var receipt = source.next();
                        assertThat(receipt.at("/payload/reason").asText()).isEqualTo("postgresql");
                        var update = viewer.next();
                        assertThat(update.path("kind").asText()).isEqualTo("update");
                        assertThat(update.at("/payload/snapshot/data/score/score").asInt()).isEqualTo(3);
                        var snapshot = get(a.viewer + "/views?viewId=match&entityId=42", "viewer", MEDIA);
                        assertThat(snapshot.statusCode()).isEqualTo(200);
                        assertThat(JSON.readTree(snapshot.body()).path("payload")).isEqualTo(update.at("/payload/snapshot"));
                        assertThat(JSON.readTree(get(a.viewer + "/views/unknown/42", "viewer", MEDIA).body()).path("kind").asText()).isEqualTo("notFound");
                        viewer.send(subscribe.replace("\"1\"", "\"3\""));
                        assertThat(viewer.next().at("/payload/subscription").asText()).isEqualTo("3");
                        var baseline = viewer.next();
                        assertThat(baseline.path("kind").asText()).isEqualTo("baseline");
                        assertThat(baseline.at("/payload/snapshot")).isEqualTo(update.at("/payload/snapshot"));

                        viewer.send(subscribe.replace("subscribe", "unsubscribe").replace("\"1\"", "\"3\""));
                        assertThat(viewer.next().path("kind").asText()).isEqualTo("unsubscribed");
                        source.send(publication.replace("Sequence\":1", "Sequence\":2"));
                        assertThat(source.next().at("/payload/status").asText()).isEqualTo("committed");
                        viewer.send(subscribe.replace("\"1\"", "\"4\""));
                        assertThat(viewer.next().path("kind").asText()).isEqualTo("subscribed");
                        assertThat(viewer.next().at("/payload/snapshot/version").asLong()).isEqualTo(2);

                        revoke.set(true);
                        viewer.send(subscribe.replace("\"1\"", "\"5\""));
                        assertThat(viewer.closed.get(4, TimeUnit.SECONDS)).isEqualTo(1008);
                        first.close();
                    }
                    awaitReady(b);
                    try (var source = socket(b.source, OPERATOR)) {
                        var hello = source.next();
                        assertThat(hello.path("incarnation").asText()).isEqualTo(incarnation);
                        assertThat(Long.parseLong(hello.path("generation").asText())).isGreaterThan(Long.parseLong(original));
                        source.send(publication);
                        var receipt = source.next();
                        assertThat(receipt.at("/payload/status").asText()).isEqualTo("duplicate");
                        assertThat(receipt.at("/payload/version").asLong()).isEqualTo(1);
                    }
                }
            }
        } finally {
            if (http != null) http.close();
            SSLContext.setDefault(previous);
        }
    }

    @Test
    @Timeout(45)
    void busyProbeNeverQueuesAndBlockedDatabaseProbeRetiresItsOwnAttempt() throws Exception {
        try (var database = new PostgresTestDatabase(); var tls = new PolicyTlsFixture(directory);
                var service = start(database, tls, false)) {
            http = HttpClient.newBuilder().sslContext(tls.trust).version(HttpClient.Version.HTTP_1_1).build();
            var node = ports(service);
            awaitReady(node);
            assertThat(get(node.viewer + "/views/match/42", "unused", "*/*").statusCode()).isEqualTo(406);
            var wrong = http.newWebSocketBuilder().subprotocols("unsupported");
            var failure = catchThrowableOfType(() -> wrong.buildAsync(URI.create(node.live), new WebSocket.Listener() {}).join(),
                    java.util.concurrent.CompletionException.class);
            assertThat(failure.getCause()).isInstanceOfSatisfying(WebSocketHandshakeException.class,
                            handshake -> assertThat(handshake.getResponse().statusCode()).isEqualTo(406));
            try (var viewer = socket(node.live, "unused")) {
                assertThat(viewer.next().path("kind").asText()).isEqualTo("hello");
                viewer.send("{\"cursor\":9}");
                assertThat(viewer.next().at("/payload/code").asText()).isEqualTo("invalidRequest");
            }
            long before = Long.parseLong(JSON.readTree(get(node.viewer + "/views/match/42", "unused", MEDIA).body())
                    .path("generation").asText());
            try (var locker = database.open(); var sql = locker.createStatement()) {
                locker.setAutoCommit(false);
                sql.execute("SELECT singleton FROM zooglass_runtime FOR UPDATE");
                int backend;
                try (var id = sql.executeQuery("SELECT pg_backend_pid()")) { id.next(); backend = id.getInt(1); }
                var request = HttpRequest.newBuilder(URI.create(node.viewer + "/ha/ready"))
                        .header("Authorization", "Bearer " + PROBE).timeout(Duration.ofSeconds(4)).build();
                long start = System.nanoTime();
                var blocked = http.sendAsync(request, HttpResponse.BodyHandlers.ofString());
                boolean observed = false;
                while (System.nanoTime() - start < TimeUnit.MILLISECONDS.toNanos(1450)) {
                    try (var row = sql.executeQuery("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE "
                            + backend + " = ANY(pg_blocking_pids(pid)))")) {
                        row.next();
                        if (row.getBoolean(1)) { observed = true; break; }
                    }
                    Thread.sleep(10);
                }
                assertThat(observed).as("the request reached a blocked database operation").isTrue();
                var immediate = http.send(request, HttpResponse.BodyHandlers.ofString());
                assertThat(immediate.statusCode()).isEqualTo(503);
                assertThat(immediate.body()).isEmpty();
                assertThat(blocked.isDone()).as("the competing probe returned while the original check was still blocked").isFalse();
                assertThat(blocked.get(3, TimeUnit.SECONDS).statusCode()).isEqualTo(503);
                assertThat(System.nanoTime() - start).isLessThan(TimeUnit.MILLISECONDS.toNanos(2750));
                locker.rollback();
            }
            awaitReady(node);
            var after = JSON.readTree(get(node.viewer + "/views/match/42", "unused", MEDIA).body());
            assertThat(Long.parseLong(after.path("generation").asText())).isGreaterThan(before);
        } finally {
            if (http != null) http.close();
        }
    }

    @Test
    @Timeout(45)
    void protectedHttpGrantExpiresAtTheFirstChunkAfterDatabaseAdmission() throws Exception {
        try (var database = new PostgresTestDatabase(); var tls = new PolicyTlsFixture(directory);
                var service = start(database, tls, true, HttpReleaseFixture.class)) {
            http = HttpClient.newBuilder().sslContext(tls.trust).version(HttpClient.Version.HTTP_1_1).build();
            var node = ports(service);
            awaitReady(node);
            for (var view : List.of("match", "unknown")) {
                String entity = "ha-expiring-" + view;
                var probe = new HttpReleaseFixture.Probe(HttpReleaseFixture.Expiry.BEFORE_FIRST_CHUNK);
                HttpReleaseFixture.probes.put(entity, probe);
                try {
                    var request = HttpRequest.newBuilder(URI.create(node.viewer + "/views/" + view + "/" + entity))
                            .header("Authorization", "Bearer viewer").header("Accept", MEDIA).header("X-Test-Case", entity)
                            .timeout(Duration.ofSeconds(4)).build();
                    var response = http.send(request, HttpResponse.BodyHandlers.ofString());
                    assertThat(response.statusCode()).isEqualTo(503);
                    assertThat(response.body()).isEmpty();
                    assertThat(probe.decisions.get()).isEqualTo(1);
                    assertThat(probe.bytes.get()).isZero();
                    assertThat(probe.writer).isNotNull();
                } finally {
                    HttpReleaseFixture.probes.remove(entity);
                }
            }
        } finally {
            if (http != null) http.close();
        }
    }

    private ConfigurableApplicationContext start(PostgresTestDatabase database, PolicyTlsFixture tls, boolean protectedMode,
            Class<?>... fixtures) throws Exception {
        Path config = directory.resolve("ha.json");
        Files.writeString(config, """
                {"contractVersion":2,"storage":"postgresql","maxStreams":6,"identityWindow":2,"maxHistoryEntries":2,
                 "sources":[{"id":"feed","epoch":"run"}],"views":[{"id":"match","fields":{"score":
                 {"sourceId":"feed","type":"updated","mode":"latestBySequence"}}}]}
                """);
        var args = new ArrayList<>(List.of("--server.port=0", "--server.ssl.enabled=true",
                "--server.ssl.key-store=" + directory.resolve("policy.p12").toUri(), "--server.ssl.key-store-password=test-password",
                "--server.forward-headers-strategy=none",
                "--zooglass.config=" + config.toUri(), "--zooglass.deployment.profile=ha-static-v1", "--zooglass.ha.runtime-id=ha-transport",
                "--zooglass.ha.database-ssl-mode=disable", "--zooglass.ha.probe-token=" + PROBE, "--zooglass.ha.database-schema=" + database.schema(),
                "--zooglass.ha.database-url=" + System.getenv("ZOOGLASS_POSTGRES_URL"), "--zooglass.ha.database-user=" + System.getenv("ZOOGLASS_POSTGRES_USER"),
                "--zooglass.ha.database-password=" + System.getenv("ZOOGLASS_POSTGRES_PASSWORD"), "--zooglass.ha.retry-ms=100", "--zooglass.ha.lease-ms=6000", "--zooglass.ha.renew-ms=4000"));
        if (protectedMode) {
            args.addAll(List.of("--zooglass.access.mode=applicationPolicy", "--zooglass.access.tenant=test",
                    "--zooglass.access.origin=https://viewer.example", "--zooglass.access.policy-url=" + tls.settings("/decision", Duration.ofSeconds(1), 8).endpoint(),
                    "--zooglass.access.service-token=service-secret", "--zooglass.access.operator-port=0", "--zooglass.access.operator-token=" + OPERATOR));
        } else {
            args.add("--zooglass.access.mode=openDemo");
        }
        return new SpringApplicationBuilder(ZooGlassApplication.class).sources(fixtures).run(args.toArray(String[]::new));
    }

    private record Ports(String viewer, String operator, String source, String live) {}
    private Ports ports(ConfigurableApplicationContext service) {
        var server = (TomcatWebServer) ((WebServerApplicationContext) service).getWebServer();
        int operator = Arrays.stream(server.getTomcat().getService().findConnectors()).filter(c -> !c.getSecure()).mapToInt(c -> c.getLocalPort()).findFirst().orElse(-1);
        return new Ports("https://localhost:" + server.getPort(), "http://127.0.0.1:" + operator,
                "ws://127.0.0.1:" + operator + "/events", "wss://localhost:" + server.getPort() + "/views/live");
    }

    private void awaitReady(Ports node) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12);
        while (System.nanoTime() < deadline) {
            if (get(node.viewer + "/ha/ready", PROBE, MEDIA).statusCode() == 200) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Candidate did not become ready");
    }

    private HttpResponse<String> get(String uri, String token, String accept) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create(uri)).header("Authorization", "Bearer " + token).header("Accept", accept)
                .timeout(Duration.ofSeconds(4)).build(), HttpResponse.BodyHandlers.ofString());
    }

    private AdmissionSocket socket(String uri, String token) {
        var socket = new AdmissionSocket(http, URI.create(uri), Map.of("Authorization", "Bearer " + token), "zooglass.ha.v1");
        assertThat(socket.subprotocol()).isEqualTo("zooglass.ha.v1");
        return socket;
    }
}
