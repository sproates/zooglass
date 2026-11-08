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
import java.util.concurrent.atomic.AtomicLong;

class NativeWssBackpressureTests {
    private static final JsonMapper JSON = new JsonMapper();
    private static PolicyTlsFixture policy;
    private static final AtomicLong revokedAt = new AtomicLong();
    private static final CompletableFuture<Void> denial = new CompletableFuture<>();
    private static final CompletableFuture<ObservedNativeSocket> movingConnected = new CompletableFuture<>();
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
                    if (identity.credential().value().equals("moving")) movingConnected.complete(observed);
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
                    boolean denied = revokedAt.get() != 0
                            && !request.path("credential").path("value").asText().equals("healthy");
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
                     "delivery":{"maxQueuedMessages":256,"maxQueuedBytes":33554432},
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
                        var moving = new AdmissionSocket(client, URI.create("wss://localhost:" + port + "/views/live"),
                                Map.of("Authorization", "Bearer moving"));
                        var healthy = new AdmissionSocket(client, URI.create("wss://localhost:" + port + "/views/live"),
                                Map.of("Authorization", "Bearer healthy"))) {
                    healthy.subscribe("positions", "healthy");
                    healthy.next();
                    healthy.next();
                    moving.subscribe("positions", "moving");
                    moving.next();
                    moving.next();
                    publish(runtime, "moving", 1);
                    assertThat(moving.next().at("/data/position/sequence").asLong()).isEqualTo(1);
                    var flowing = movingConnected.get(3, TimeUnit.SECONDS);
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
                    // The authority commits this value; policy reads and native send probes
                    // use the same monotonic clock in this process.
                    long committed = System.nanoTime();
                    revokedAt.set(committed);
                    long cutoff = committed + TimeUnit.SECONDS.toNanos(5);
                    publishAcrossCutoff(runtime, healthy, cutoff);
                    denial.get(1, TimeUnit.SECONDS);
                    assertThat(currentLease(grants, observed.viewer)).isNull();
                    assertThat(observed.submissions.get()).isEqualTo(beforeRevocation);
                    assertThat(moving.closed.get(2, TimeUnit.SECONDS)).isEqualTo(1008);

                    // Drain the old, already-submitted baseline after cutoff. Its delayed
                    // arrival is permitted; no queued successor may now reach sendText.
                    slow.resumeReading().get(10, TimeUnit.SECONDS);
                    observed.closed.get(5, TimeUnit.SECONDS);
                    assertThat(observed.submissions.get()).isEqualTo(beforeRevocation);
                    assertBeforeCutoff(observed, committed, cutoff);
                    assertBeforeCutoff(flowing, committed, cutoff);
                    assertThat(flowing.history).anyMatch(write -> write.startedNanos() > committed);

                }
            }
        }
    }
    private static void publishAcrossCutoff(ViewCoordinator runtime, AdmissionSocket healthy, long cutoff)
            throws Exception {
        boolean before = false;
        boolean after = false;
        long sequence = 3;
        while (System.nanoTime() < cutoff + TimeUnit.MILLISECONDS.toNanos(200)) {
            publish(runtime, "slow", sequence);
            publish(runtime, "moving", sequence);
            publish(runtime, "healthy", sequence);
            assertThat(healthy.next().at("/data/position/sequence").asLong()).isEqualTo(sequence);
            long received = System.nanoTime();
            before |= received < cutoff;
            after |= received >= cutoff;
            sequence++;
            Thread.sleep(100);
        }
        assertThat(sequence).as("publications continue across the cutoff").isGreaterThan(4);
        assertThat(before).as("healthy delivery before cutoff").isTrue();
        assertThat(after).as("healthy delivery after cutoff").isTrue();
    }

    private static void publish(ViewCoordinator runtime, String entity, long sequence) {
        var outcome = runtime.apply(new Publication("fleet", "run", entity, sequence, "position",
                JSON.createObjectNode().put("sequence", sequence)));
        assertThat(outcome.status()).isEqualTo("applied");
    }

    private static void assertBeforeCutoff(ObservedNativeSocket socket, long committed, long cutoff)
            throws Exception {
        assertThat(socket.history).isNotEmpty();
        long lastHandoff = Long.MIN_VALUE;
        for (var write : socket.history) {
            assertThat(write.startedNanos()).as("native submission must begin before cutoff").isLessThan(cutoff);
            lastHandoff = Math.max(lastHandoff, write.submitted().get(2, TimeUnit.SECONDS));
        }
        assertThat(lastHandoff - committed).as("last native handoff relative to authority commit, in nanoseconds")
                .isLessThan(TimeUnit.SECONDS.toNanos(5));
    }

    private static ActiveViewGrants.Lease currentLease(ActiveViewGrants grants, WebSocketSession viewer)
            throws Exception {
        // A regression that waits for network completion under the grant monitor must
        // fail promptly, allowing the test's finally blocks to terminate the peer.
        return CompletableFuture.supplyAsync(() -> grants.capture(viewer, null)).get(2, TimeUnit.SECONDS);
    }

}
