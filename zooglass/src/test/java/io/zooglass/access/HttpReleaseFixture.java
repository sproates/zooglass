package io.zooglass.access;

import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.Filter;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** Observes real servlet writes. Only the grant clock is controlled by the test. */
@TestConfiguration(proxyBeanMethods = false)
class HttpReleaseFixture {

    enum Expiry { MANUAL, BEFORE_FIRST_CHUNK, AFTER_TWO_CHUNKS, BEFORE_EMPTY_COMMIT, ON_COMPLETE }

    static final class Probe {
        final Expiry expiry;
        final AtomicLong clock = new AtomicLong();
        final AtomicInteger bytes = new AtomicInteger();
        final AtomicInteger decisions = new AtomicInteger();
        final CompletableFuture<Boolean> committed = new CompletableFuture<>();
        final CompletableFuture<Void> stalled = new CompletableFuture<>();
        final CompletableFuture<Void> completed = new CompletableFuture<>();
        volatile WriteListener writer;

        Probe(Expiry expiry) { this.expiry = expiry; }
        void expire() { clock.set(1_000_000_000L); }
    }

    static final ConcurrentHashMap<String, Probe> probes = new ConcurrentHashMap<>();

    @Bean
    @Primary
    AdmissionAccess protectedAdmission() {
        return new AdmissionAccess(new ViewerAccess() {
            public AccessDecision authenticate(ViewerCredential credential) {
                throw new UnsupportedOperationException("This fixture exercises HTTP only");
            }
            public AccessDecision authorise(ViewerCredential credential, ViewResource resource) {
                var probe = probes.get(resource.entityId());
                probe.decisions.incrementAndGet();
                return new AccessDecision.Granted(new AccessGrant("tenant-a", "operator", resource,
                        0, 1000, probe.clock::get));
            }
            public void close() {}
        }, "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
    }

    @Bean
    FilterRegistrationBean<Filter> observedWrites() {
        Filter filter = (request, response, chain) -> {
            var http = (HttpServletRequest) request;
            var probe = probes.get(http.getHeader("X-Test-Case"));
            if (probe == null) {
                chain.doFilter(request, response);
                return;
            }
            chain.doFilter(request, new HttpServletResponseWrapper((HttpServletResponse) response) {
                private ServletOutputStream observed;

                @Override
                public void setContentLength(int length) {
                    super.setContentLength(length);
                    if (length == 0 && probe.expiry == Expiry.BEFORE_EMPTY_COMMIT) probe.expire();
                }

                @Override
                public ServletOutputStream getOutputStream() throws IOException {
                    if (observed == null) observed = observe(super.getOutputStream(), http, probe);
                    return observed;
                }
            });
        };
        var registration = new FilterRegistrationBean<>(filter);
        registration.setAsyncSupported(true);
        return registration;
    }

    private ServletOutputStream observe(ServletOutputStream output, HttpServletRequest request, Probe probe) {
        return new ServletOutputStream() {
            @Override
            public boolean isReady() {
                boolean ready = output.isReady();
                if (!ready) probe.stalled.complete(null);
                if (ready && probe.expiry == Expiry.BEFORE_FIRST_CHUNK) probe.expire();
                return ready;
            }

            @Override
            public void setWriteListener(WriteListener listener) {
                probe.writer = listener;
                var response = (HttpServletResponse) request.getAsyncContext().getResponse();
                request.getAsyncContext().addListener(new AsyncListener() {
                    public void onComplete(AsyncEvent event) {
                        probe.committed.complete(response.isCommitted());
                        if (probe.expiry == Expiry.ON_COMPLETE) probe.expire();
                        probe.completed.complete(null);
                    }
                    public void onError(AsyncEvent event) {}
                    public void onTimeout(AsyncEvent event) {}
                    public void onStartAsync(AsyncEvent event) {}
                });
                output.setWriteListener(listener);
            }

            @Override
            public void flush() throws IOException { output.flush(); }

            @Override
            public void write(int value) throws IOException { write(new byte[] {(byte) value}, 0, 1); }

            @Override
            public void write(byte[] bytes, int offset, int length) throws IOException {
                output.write(bytes, offset, length);
                int accepted = probe.bytes.addAndGet(length);
                if (accepted >= 16384 && probe.expiry == Expiry.AFTER_TWO_CHUNKS) probe.expire();
            }
        };
    }
}
