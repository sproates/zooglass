package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.ZooGlassApplication;
import io.zooglass.delivery.SnapshotBroadcaster;
import io.zooglass.delivery.SnapshotSubscriptions;
import io.zooglass.runtime.Publication;
import io.zooglass.runtime.ViewCoordinator;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

class NativeWssBackpressureTests {
    private static final JsonMapper JSON = new JsonMapper();
    private static PolicyTlsFixture policy;
    private static final AtomicBoolean revoked = new AtomicBoolean();
    private static final CompletableFuture<Void> denial = new CompletableFuture<>();
    private static final CompletableFuture<ObservedNativeSocket> slowConnected = new CompletableFuture<>();

    @TestConfiguration(proxyBeanMethods = false)
    static class ProtectedFixture {
        @Bean
        @Primary
        AdmissionAccess protectedAdmission() {
            return new AdmissionAccess(new ApplicationPolicyAccess("tenant-a",
                    new HttpsPolicyClient(policy.settings("/decision", Duration.ofSeconds(2), 8), policy.trust),
                    System::nanoTime), "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
        }

        @Bean
        @Primary
        SnapshotSubscriptions observedSubscriptions(ObjectMapper json, SnapshotBroadcaster broadcaster,
                AdmissionAccess access) {
            return new SnapshotSubscriptions(json, broadcaster, access) {
                private final Map<String, ObservedNativeSocket> sockets = new ConcurrentHashMap<>();

                @Override
                public void afterConnectionEstablished(WebSocketSession session) {
                    var observed = new ObservedNativeSocket(session);
                    sockets.put(session.getId(), observed);
                    super.afterConnectionEstablished(observed.viewer);
                    var identity = (ViewerHandshake.Identity) session.getAttributes().get(ViewerHandshake.IDENTITY);
                    if (identity.credential().value().equals("slow")) slowConnected.complete(observed);
                }

                @Override
                protected void handleTextMessage(WebSocketSession session, TextMessage message) {
                    super.handleTextMessage(sockets.get(session.getId()).viewer, message);
                }

                @Override
                public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
                    var observed = sockets.remove(session.getId());
                    if (observed != null) {
                        super.afterConnectionClosed(observed.viewer, status);
                        observed.closed.complete(null);
                    }
                }
            };
        }
    }

    @Test
    void realTlsBackpressureDoesNotDelayRevocationOrHealthyDelivery(@TempDir Path directory) throws Exception {
        try (var fixture = new PolicyTlsFixture(directory)) {
            policy = fixture;
            policy.handle("/decision", exchange -> {
                try (exchange) {
                    var request = JSON.readTree(exchange.getRequestBody());
                    boolean denied = revoked.get() && request.path("credential").path("value").asText().equals("slow");
                    String reply = denied ? "{\"decision\":\"deny\"}"
                            : "{\"decision\":\"allow\",\"subject\":\"operator\",\"lifetimeMillis\":5000}";
                    byte[] bytes = reply.getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, bytes.length);
                    exchange.getResponseBody().write(bytes);
                    if (denied) denial.complete(null);
                }
            });
            Path config = directory.resolve("views.json");
            Files.writeString(config, """
                    {"contractVersion":2,"storage":"memory","maxStreams":10,"identityWindow":10,"maxHistoryEntries":10,
                     "delivery":{"maxQueuedMessages":8,"maxQueuedBytes":33554432},
                     "sources":[{"id":"fleet","epoch":"run"}],
                     "views":[{"id":"positions","fields":{"position":
                       {"sourceId":"fleet","type":"position","mode":"latestBySequence"}}}]}
                    """);
            try (var service = new SpringApplicationBuilder(ZooGlassApplication.class, ProtectedFixture.class).run(
                    "--server.port=0", "--spring.main.banner-mode=off", "--server.ssl.enabled=true",
                    "--server.ssl.key-store=" + directory.resolve("policy.p12").toUri(),
                    "--server.ssl.key-store-password=test-password", "--server.ssl.key-store-type=PKCS12",
                    "--server.forward-headers-strategy=none", "--zooglass.config=" + config.toUri());
                    var client = HttpClient.newBuilder().sslContext(policy.trust).build()) {
                int port = ((WebServerApplicationContext) service).getWebServer().getPort();
                var runtime = service.getBean(ViewCoordinator.class);
                var grants = (ActiveViewGrants) ReflectionTestUtils.getField(
                        service.getBean(SnapshotBroadcaster.class), "grants");
                var large = JSON.createObjectNode().put("body", "x".repeat(8 * 1024 * 1024));
                runtime.apply(new Publication("fleet", "run", "slow", 1, "position", large));
                try (var slow = new UnreadWssClient(policy.trust, port);
                        var healthy = new AdmissionSocket(client, URI.create("wss://localhost:" + port + "/views/live"),
                                Map.of("Authorization", "Bearer healthy"))) {
                    healthy.subscribe("positions", "healthy");
                    healthy.next();
                    healthy.next();
                    slow.subscribe();
                    var observed = slowConnected.get(3, TimeUnit.SECONDS);
                    var ack = observed.writes.poll(3, TimeUnit.SECONDS);
                    assertThat(ack).isNotNull();
                    ack.completed().get(3, TimeUnit.SECONDS);
                    var stalled = observed.writes.poll(3, TimeUnit.SECONDS);
                    assertThat(stalled).isNotNull();
                    assertThat(stalled.characters()).isGreaterThan(8 * 1024 * 1024);
                    stalled.submitted().get(3, TimeUnit.SECONDS);
                    // A returned native submission with no send completion and no peer reads
                    // demonstrates actual transport backpressure, not a delayed callback stub.
                    assertThatThrownBy(() -> stalled.completed().get(200, TimeUnit.MILLISECONDS))
                            .isInstanceOf(java.util.concurrent.TimeoutException.class);
                    runtime.apply(new Publication("fleet", "run", "slow", 2, "position", large));
                    assertThat(currentLease(grants, observed.viewer)).isNotNull();
                    int beforeRevocation = observed.submissions.get();
                    assertThat(beforeRevocation).as("only acknowledgement and blocked baseline submitted").isEqualTo(2);
                    assertThat(stalled.completed().isDone()).isFalse();
                    revoked.set(true);
                    denial.get(5, TimeUnit.SECONDS);
                    long limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                    while (currentLease(grants, observed.viewer) != null && System.nanoTime() < limit) Thread.sleep(10);
                    assertThat(currentLease(grants, observed.viewer)).isNull();
                    assertThat(observed.submissions.get()).isEqualTo(beforeRevocation);
                    runtime.apply(new Publication("fleet", "run", "healthy", 1, "position",
                            JSON.createObjectNode().put("latitude", 36.14)));
                    assertThat(healthy.next().at("/data/position/latitude").doubleValue()).isEqualTo(36.14);
                    slow.close();
                    observed.closed.get(5, TimeUnit.SECONDS);
                    assertThat(observed.submissions.get()).isEqualTo(beforeRevocation);
                }
            }
        }
    }
    private static ActiveViewGrants.Lease currentLease(ActiveViewGrants grants, WebSocketSession viewer)
            throws Exception {
        // A regression that waits for network completion under the grant monitor must
        // fail promptly, allowing the test's finally blocks to terminate the peer.
        return CompletableFuture.supplyAsync(() -> grants.capture(viewer, null)).get(2, TimeUnit.SECONDS);
    }

}
