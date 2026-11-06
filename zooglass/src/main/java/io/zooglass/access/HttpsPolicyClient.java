package io.zooglass.access;

import javax.net.ssl.SSLContext;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

/** Fixed HTTPS destination, bounded response/time/concurrency, and no redirects or retries. */
final class HttpsPolicyClient implements PolicyClient {

    private final PolicySettings settings;
    private final HttpClient client;
    private final Semaphore capacity;
    private final AtomicBoolean closed = new AtomicBoolean();

    HttpsPolicyClient(PolicySettings settings) {
        this(settings, null);
    }

    // Tests install a trust store for their local HTTPS authority; hostname checks stay enabled.
    HttpsPolicyClient(PolicySettings settings, SSLContext trust) {
        this.settings = settings;
        var builder = HttpClient.newBuilder()
                .connectTimeout(settings.timeout())
                .followRedirects(HttpClient.Redirect.NEVER);
        if (trust != null) {
            builder.sslContext(trust);
        }
        client = builder.build();
        capacity = new Semaphore(settings.maxConcurrent());
    }

    @Override
    public PolicyReply decide(ViewerCredential credential, ViewResource resource) {
        if (closed.get() || !capacity.tryAcquire()) {
            return PolicyReply.unavailable();
        }
        long started = System.nanoTime();
        CompletableFuture<HttpResponse<byte[]>> pending = null;
        try {
            if (closed.get()) {
                return PolicyReply.unavailable();
            }
            var request = HttpRequest.newBuilder(settings.endpoint())
                    .timeout(settings.timeout())
                    .header("Authorization", "Bearer " + settings.serviceToken())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(
                            PolicyJson.request(settings.tenant(), credential, resource)))
                    .build();
            pending = client.sendAsync(request, ignored -> new LimitedPolicyBody());
            long remaining = settings.timeout().toNanos() - (System.nanoTime() - started);
            if (remaining <= 0) {
                return PolicyReply.unavailable();
            }
            var response = pending.get(remaining, TimeUnit.NANOSECONDS);
            String contentType = response.headers().firstValue("Content-Type").orElse("");
            if (response.statusCode() != 200
                    || !"application/json".equalsIgnoreCase(contentType.split(";", 2)[0].strip())) {
                return PolicyReply.unavailable();
            }
            return PolicyJson.response(response.body());
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            return PolicyReply.unavailable();
        } catch (ExecutionException | TimeoutException | CancellationException | RejectedExecutionException failure) {
            return PolicyReply.unavailable();
        } finally {
            if (pending != null && !pending.isDone()) {
                pending.cancel(true);
            }
            capacity.release();
        }
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            client.shutdownNow();
        }
    }
}
