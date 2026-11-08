package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.ZooGlassApplication;
import io.zooglass.runtime.Publication;
import io.zooglass.runtime.ViewCoordinator;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;

import tools.jackson.databind.json.JsonMapper;

import javax.net.ssl.SSLSocket;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.TimeUnit;

class HttpReleaseAcceptanceTests {

    @TempDir static Path directory;
    private static PolicyTlsFixture tls;
    private static ConfigurableApplicationContext service;
    private static HttpClient client;
    private static int port;
    private static final JsonMapper JSON = new JsonMapper();

    @BeforeAll
    static void start() throws Exception {
        tls = new PolicyTlsFixture(directory);
        Path config = directory.resolve("views.json");
        Files.writeString(config, """
                {"contractVersion":2,"storage":"memory","maxStreams":10,"identityWindow":10,"maxHistoryEntries":10, "sources":[{"id":"feed","epoch":"run"}],
                 "views":[{"id":"positions","fields":{"position":
                   {"sourceId":"feed","type":"position","mode":"latestBySequence"}}}]}
                """);
        service = new SpringApplicationBuilder(ZooGlassApplication.class, HttpReleaseFixture.class).run(
                "--server.port=0", "--spring.main.banner-mode=off", "--server.ssl.enabled=true",
                "--server.ssl.key-store=" + directory.resolve("policy.p12").toUri(),
                "--server.ssl.key-store-password=test-password", "--server.ssl.key-store-type=PKCS12",
                "--server.http2.enabled=true", "--zooglass.config=" + config.toUri());
        port = ((WebServerApplicationContext) service).getWebServer().getPort();
        client = HttpClient.newBuilder().sslContext(tls.trust).version(HttpClient.Version.HTTP_1_1).build();
    }

    @AfterAll
    static void stop() {
        if (client != null) client.close();
        if (service != null) service.close();
        if (tls != null) tls.close();
        HttpReleaseFixture.probes.clear();
    }

    @Test
    void bodylessResultCommitsWhileAllowedRatherThanAfterAsyncCompletion() throws Exception {
        for (boolean query : new boolean[] {false, true}) {
            String entity = "empty-completion-" + query;
            var probe = probe(entity, HttpReleaseFixture.Expiry.ON_COMPLETE);
            var response = get(entity, query, "unknown");
            probe.completed.get(3, TimeUnit.SECONDS);
            assertThat(probe.committed.get(3, TimeUnit.SECONDS)).isTrue();
            assertThat(probe.clock.get()).isEqualTo(1_000_000_000L);
            // Expiry after the checked commit cannot retract an already released status.
            assertThat(response.statusCode()).isEqualTo(404);
            assertThat(response.body()).isEmpty();
        }
    }

    @Test
    void expiryDuringEmptyResponsePreparationIsCheckedBeforeCommit() throws Exception {
        for (boolean query : new boolean[] {false, true}) {
            String entity = "empty-preparation-" + query;
            var probe = probe(entity, HttpReleaseFixture.Expiry.BEFORE_EMPTY_COMMIT);
            var response = get(entity, query, "unknown");
            assertThat(response.statusCode()).isEqualTo(503);
            assertThat(response.body()).isEmpty();
            probe.completed.get(3, TimeUnit.SECONDS);
        }
    }

    @Test
    void protectedHttp2IsRefusedBeforePolicyOrSnapshotDelivery() throws Exception {
        try (var http2 = HttpClient.newBuilder().sslContext(tls.trust).version(HttpClient.Version.HTTP_2).build()) {
            for (boolean query : new boolean[] {false, true}) {
                String entity = "unsupported-" + query;
                var probe = probe(entity, HttpReleaseFixture.Expiry.MANUAL);
                publish(entity, 100);
                String path = query ? "/views?viewId=positions&entityId=" + entity : "/views/positions/" + entity;
                var request = HttpRequest.newBuilder(URI.create("https://localhost:" + port + path))
                        .header("Authorization", "Bearer viewer").header("X-Test-Case", entity)
                        .timeout(Duration.ofSeconds(5)).GET().build();
                var response = http2.send(request, HttpResponse.BodyHandlers.ofString());
                assertThat(response.version()).isEqualTo(HttpClient.Version.HTTP_2);
                assertThat(response.statusCode()).isEqualTo(505);
                assertThat(response.body()).isEmpty();
                assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
                assertThat(probe.decisions.get()).isZero();
                assertThat(probe.bytes.get()).isZero();
                assertThat(probe.writer).isNull();
            }
        }
    }

    @Test
    void expiryAtFirstReadyCallbackHidesBothSnapshotAndMissingResourceOnBothRoutes() throws Exception {
        for (int variant = 0; variant < 4; variant++) {
            boolean query = variant % 2 == 0;
            String entity = "before-" + variant;
            var probe = probe(entity, HttpReleaseFixture.Expiry.BEFORE_FIRST_CHUNK);
            if (variant < 2) publish(entity, 100);
            var response = get(entity, query, variant < 2 ? "positions" : "unknown");
            assertThat(response.statusCode()).isEqualTo(503);
            assertThat(response.body()).isEmpty();
            assertThat(response.headers().firstValue("Cache-Control")).contains("no-store");
            assertThat(probe.bytes.get()).isZero();
            probe.completed.get(3, TimeUnit.SECONDS);
        }
    }

    @Test
    void expiryAfterCommitProducesTruncationRatherThanSuccessfulJson() throws Exception {
        String entity = "partial";
        var probe = probe(entity, HttpReleaseFixture.Expiry.AFTER_TWO_CHUNKS);
        publish(entity, 200_000);
        try {
            var result = get(entity, false);
            throw new AssertionError("Partial response was accepted: " + result.statusCode());
        } catch (IOException truncated) {
            // The declared content length cannot be satisfied after the real transport abort.
            assertThat(truncated).isNotInstanceOf(java.net.http.HttpTimeoutException.class);
        }
        probe.completed.get(3, TimeUnit.SECONDS);
        assertThat(probe.bytes.get()).isEqualTo(16384);
    }

    @Test
    void unreadTlsPeerStopsNativeWritesThenExpiresWithoutBlockingAnotherRead() throws Exception {
        String entity = "unread";
        var probe = probe(entity, HttpReleaseFixture.Expiry.MANUAL);
        publish(entity, 8 * 1024 * 1024);
        try (var peer = (SSLSocket) tls.trust.getSocketFactory().createSocket()) {
            peer.setReceiveBufferSize(1024);
            peer.setSoTimeout(8000);
            var parameters = peer.getSSLParameters();
            parameters.setEndpointIdentificationAlgorithm("HTTPS");
            peer.setSSLParameters(parameters);
            peer.connect(new InetSocketAddress("localhost", port), 3000);
            peer.startHandshake();
            peer.getOutputStream().write(("GET /views/positions/" + entity + " HTTP/1.1\r\n"
                    + "Host: localhost\r\nAuthorization: Bearer viewer\r\nX-Test-Case: " + entity
                    + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            String headers = readHeaders(peer);
            assertThat(headers).startsWith("HTTP/1.1 200").contains("Content-Length:");
            // No body reads: this is TCP/TLS backpressure, not a blocked application callback.
            probe.stalled.get(4, TimeUnit.SECONDS);
            // Order the controlled clock jump with a handoff already in progress.
            // A bounded wait also detects an incorrectly blocking writer monitor.
            int submitted = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
                synchronized (probe.writer) {
                    probe.expire();
                    return probe.bytes.get();
                }
            }).get(2, TimeUnit.SECONDS);
            assertThat(submitted).isBetween(8192, 8 * 1024 * 1024 - 1);

            probe("healthy", HttpReleaseFixture.Expiry.MANUAL);
            publish("healthy", 10);
            var healthy = get("healthy", true);
            assertThat(healthy.statusCode()).isEqualTo(200);
            assertThat(JSON.readTree(healthy.body()).path("data").path("position").path("text").asText())
                    .isEqualTo("x".repeat(10));

            long received = 0;
            try {
                byte[] buffer = new byte[16384];
                for (int length; (length = peer.getInputStream().read(buffer)) != -1;) received += length;
            } catch (IOException reset) {
                // Either a reset or EOF with fewer bytes than the promised body is an abort.
                assertThat(reset).isNotInstanceOf(java.net.SocketTimeoutException.class);
            }
            probe.completed.get(3, TimeUnit.SECONDS);
            assertThat(probe.bytes.get()).isEqualTo(submitted);
            assertThat(received).isLessThan(8 * 1024 * 1024);
        }
    }

    private static String readHeaders(SSLSocket peer) throws IOException {
        var bytes = new java.io.ByteArrayOutputStream();
        while (bytes.size() < 16_384) {
            int next = peer.getInputStream().read();
            if (next < 0) throw new IOException("Response ended before headers");
            bytes.write(next);
            if (bytes.toString(StandardCharsets.US_ASCII).endsWith("\r\n\r\n")) {
                return bytes.toString(StandardCharsets.US_ASCII);
            }
        }
        throw new IOException("Response headers too large");
    }

    private static HttpReleaseFixture.Probe probe(String entity, HttpReleaseFixture.Expiry expiry) {
        var probe = new HttpReleaseFixture.Probe(expiry);
        HttpReleaseFixture.probes.put(entity, probe);
        return probe;
    }

    private HttpResponse<String> get(String entity, boolean query) throws Exception {
        return get(entity, query, "positions");
    }

    private HttpResponse<String> get(String entity, boolean query, String view) throws Exception {
        String path = query ? "/views?viewId=" + view + "&entityId=" + entity : "/views/" + view + "/" + entity;
        var request = HttpRequest.newBuilder(URI.create("https://localhost:" + port + path))
                .header("Authorization", "Bearer viewer").header("X-Test-Case", entity)
                .timeout(Duration.ofSeconds(5)).GET().build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private void publish(String entity, int size) {
        service.getBean(ViewCoordinator.class).apply(new Publication("feed", "run", entity,
                1, "position", JSON.readTree("{\"text\":\"" + "x".repeat(size) + "\"}")));
    }
}
