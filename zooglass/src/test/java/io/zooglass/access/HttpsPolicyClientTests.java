package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpExchange;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

class HttpsPolicyClientTests {

    @TempDir static Path directory;
    private static PolicyTlsFixture fixture;
    private static final String ALLOW = "{\"decision\":\"allow\",\"subject\":\"operator\",\"lifetimeMillis\":5000}";

    @BeforeAll
    static void start() throws Exception {
        fixture = new PolicyTlsFixture(directory);
    }

    @AfterAll
    static void stop() {
        if (fixture != null) {
            fixture.close();
        }
    }

    @Test
    void authenticatesTheServiceAndSendsOnlyTheSelectedViewerCredential() throws Exception {
        var request = new AtomicReference<String>();
        var token = new AtomicReference<String>();
        fixture.handle("/allow", exchange -> {
            token.set(exchange.getRequestHeaders().getFirst("Authorization"));
            request.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            respond(exchange, 200, ALLOW);
        });
        var settings = fixture.settings("/allow", Duration.ofSeconds(3), 2);
        try (var client = new HttpsPolicyClient(settings, fixture.trust);
                var access = new ApplicationPolicyAccess(settings.tenant(), client, System::nanoTime)) {
            var result = access.authorise(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER);
            assertThat(result).isInstanceOf(AccessDecision.Granted.class);
            assertThat(((AccessDecision.Granted) result).grant().permits(AccessStrategyTests.ORDER)).isTrue();
            assertThat(token.get()).isEqualTo("Bearer service-secret");
            var body = new JsonMapper().readTree(request.get());
            assertThat(body.path("tenant").asText()).isEqualTo("tenant-a");
            assertThat(body.path("credential").path("value").asText()).isEqualTo("caller-token");
            assertThat(body.path("resource").path("entityId").asText()).isEqualTo("42");
            assertThat(request.get()).doesNotContain("service-secret");
        }
    }

    @Test
    void untrustedCertificatesAndWrongHostnamesAreUnavailable() {
        fixture.handle("/tls", exchange -> respond(exchange, 200, ALLOW));
        var settings = fixture.settings("/tls", Duration.ofSeconds(3), 1);
        try (var untrusted = new HttpsPolicyClient(settings)) {
            assertThat(untrusted.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER))
                    .isEqualTo(PolicyReply.unavailable());
        }
        var wrongHost = new PolicySettings(settings.tenant(),
                URI.create(settings.endpoint().toString().replace("localhost", "127.0.0.1")),
                settings.serviceToken(), settings.timeout(), 1);
        try (var client = new HttpsPolicyClient(wrongHost, fixture.trust)) {
            assertThat(client.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER))
                    .isEqualTo(PolicyReply.unavailable());
        }
    }

    @Test
    void redirectsNeverForwardCredentials() {
        var forwarded = new AtomicInteger();
        fixture.handle("/redirect-target", exchange -> {
            forwarded.incrementAndGet();
            respond(exchange, 200, ALLOW);
        });
        fixture.handle("/redirect", exchange -> {
            exchange.getResponseHeaders().set("Location", "/redirect-target");
            respond(exchange, 307, "");
        });
        try (var client = new HttpsPolicyClient(fixture.settings("/redirect", Duration.ofSeconds(3), 1), fixture.trust)) {
            assertThat(client.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER))
                    .isEqualTo(PolicyReply.unavailable());
        }
        assertThat(forwarded).hasValue(0);
    }

    @Test
    void rejectsHttpFailuresWrongMediaTypeAndOversizedChunkedBodies() {
        fixture.handle("/http-error", exchange -> respond(exchange, 401, "{\"decision\":\"unauthenticated\"}"));
        fixture.handle("/wrong-type", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", "text/html");
            respond(exchange, 200, ALLOW);
        });
        fixture.handle("/oversize", exchange -> respond(exchange, 200, " ".repeat(16 * 1024 + 1) + ALLOW));
        for (String path : new String[] {"/http-error", "/wrong-type", "/oversize"}) {
            try (var client = new HttpsPolicyClient(fixture.settings(path, Duration.ofSeconds(3), 1), fixture.trust)) {
                assertThat(client.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER))
                        .as(path).isEqualTo(PolicyReply.unavailable());
            }
        }
    }

    @Test
    void timeoutCoversAStalledBodyAndCapacityIsNotQueued() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        fixture.handle("/stall", exchange -> {
            try (exchange) {
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, 0);
                exchange.getResponseBody().write('{');
                exchange.getResponseBody().flush();
                entered.countDown();
                await(release);
            }
        });
        var settings = fixture.settings("/stall", Duration.ofSeconds(2), 1);
        try (var client = new HttpsPolicyClient(settings, fixture.trust)) {
            var first = CompletableFuture.supplyAsync(
                    () -> client.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                var second = CompletableFuture.supplyAsync(
                        () -> client.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER));
                assertThat(second.get(1, TimeUnit.SECONDS)).isEqualTo(PolicyReply.unavailable());
                assertThat(first.get(4, TimeUnit.SECONDS)).isEqualTo(PolicyReply.unavailable());
            } finally {
                release.countDown();
                first.cancel(true);
            }
        }
    }

    @Test
    void closeCancelsInflightCallsAndPreventsNewCalls() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        fixture.handle("/close", exchange -> {
            try (exchange) {
                entered.countDown();
                await(release);
            }
        });
        try (var client = new HttpsPolicyClient(fixture.settings("/close", Duration.ofSeconds(5), 1), fixture.trust)) {
            var pending = CompletableFuture.supplyAsync(
                    () -> client.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                client.close();
                assertThat(pending.get(2, TimeUnit.SECONDS)).isEqualTo(PolicyReply.unavailable());
                assertThat(client.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER))
                        .isEqualTo(PolicyReply.unavailable());
            } finally {
                release.countDown();
                pending.cancel(true);
            }
        }
    }

    @Test
    void concurrentRepliesStayBoundToTheirOwnRequest() throws Exception {
        var bothEntered = new CountDownLatch(2);
        fixture.handle("/concurrent", exchange -> {
            var body = new JsonMapper().readTree(exchange.getRequestBody());
            String entity = body.path("resource").path("entityId").asText();
            bothEntered.countDown();
            await(bothEntered);
            respond(exchange, 200, "42".equals(entity) ? ALLOW : "{\"decision\":\"deny\"}");
        });
        var settings = fixture.settings("/concurrent", Duration.ofSeconds(3), 2);
        try (var access = new ApplicationPolicyAccess(settings.tenant(),
                new HttpsPolicyClient(settings, fixture.trust), System::nanoTime)) {
            var allowed = CompletableFuture.supplyAsync(
                    () -> access.authorise(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER));
            var denied = CompletableFuture.supplyAsync(
                    () -> access.authorise(AccessStrategyTests.CREDENTIAL, new ViewResource("orders", "43")));
            var result = allowed.get(5, TimeUnit.SECONDS);
            assertThat(result).isInstanceOf(AccessDecision.Granted.class);
            var grant = ((AccessDecision.Granted) result).grant();
            assertThat(grant.resource()).isEqualTo(AccessStrategyTests.ORDER);
            assertThat(denied.get(5, TimeUnit.SECONDS))
                    .isEqualTo(new AccessDecision.Rejected(AccessDecision.Reason.DENIED));
        }
    }

    @Test
    void interruptionCancelsTheCallAndPreservesTheInterruptFlag() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var result = new AtomicReference<PolicyReply>();
        var interrupted = new AtomicBoolean();
        fixture.handle("/interrupt", exchange -> {
            try (exchange) {
                entered.countDown();
                await(release);
            }
        });
        try (var client = new HttpsPolicyClient(
                fixture.settings("/interrupt", Duration.ofSeconds(5), 1), fixture.trust)) {
            var caller = Thread.ofVirtual().start(() -> {
                result.set(client.decide(AccessStrategyTests.CREDENTIAL, AccessStrategyTests.ORDER));
                interrupted.set(Thread.currentThread().isInterrupted());
            });
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                caller.interrupt();
                caller.join(2000);
                assertThat(caller.isAlive()).isFalse();
                assertThat(result.get()).isEqualTo(PolicyReply.unavailable());
                assertThat(interrupted).isTrue();
            } finally {
                caller.interrupt();
                release.countDown();
            }
        }
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        try (exchange) {
            if (exchange.getResponseHeaders().getFirst("Content-Type") == null) {
                exchange.getResponseHeaders().set("Content-Type", "application/json");
            }
            exchange.sendResponseHeaders(status, 0);
            exchange.getResponseBody().write(body.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void await(CountDownLatch latch) throws IOException {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new IOException("Fixture release timed out");
            }
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw new IOException("Fixture interrupted");
        }
    }
}
