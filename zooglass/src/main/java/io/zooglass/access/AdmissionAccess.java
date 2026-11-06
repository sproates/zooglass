package io.zooglass.access;

import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.Collections;
import java.util.List;

/** Shared HTTP/handshake admission. Protected construction is internal until release enforcement. */
@Component
public final class AdmissionAccess {

    private static final List<String> PROTECTED_SETTINGS = List.of(
            "tenant", "policy-url", "service-token", "origin", "session-cookie", "timeout-ms", "max-concurrent");
    private final ViewerAccess strategy;
    private final String tenant;
    private final String origin;
    private final String cookie;

    @Autowired
    public AdmissionAccess(Environment environment) {
        this();
        String mode = environment.getProperty("zooglass.access.mode", "openDemo");
        if ("openDemo".equals(mode)) {
            if (PROTECTED_SETTINGS.stream().anyMatch(key -> environment.containsProperty("zooglass.access." + key))) {
                throw new IllegalArgumentException("Open demo access cannot have protected access settings");
            }
            return;
        }
        if (!"applicationPolicy".equals(mode)) {
            throw new IllegalArgumentException("Unknown zooglass.access.mode");
        }
        // No bypass flag: configuration cannot enable admission without active release checks.
        throw new IllegalArgumentException("Application policy serving is not enabled until active delivery enforcement is complete");
    }

    public AdmissionAccess() {
        this.strategy = AccessStrategySelection.select(AccessStrategySelection.Mode.OPEN_DEMO, null);
        this.tenant = null;
        this.origin = null;
        this.cookie = null;
    }

    AdmissionAccess(ViewerAccess strategy, String tenant, String origin, String cookie) {
        URI uri = URI.create(origin);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || !uri.getRawPath().isEmpty()
                || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Allowed browser origin must be an HTTPS origin");
        }
        if (tenant == null || tenant.isBlank() || !tenant.equals(tenant.strip())) {
            throw new IllegalArgumentException("A tenant ID is required");
        }
        ViewerCredential.read(List.of(), List.of(), cookie);
        this.strategy = java.util.Objects.requireNonNull(strategy);
        this.tenant = tenant;
        this.origin = origin;
        this.cookie = cookie;
    }

    public boolean protectedMode() {
        return tenant != null;
    }

    public String tenant() {
        return tenant;
    }

    public String origin() {
        return origin;
    }

    public ViewerCredential credential(HttpServletRequest request, boolean socket) {
        if (!protectedMode()) {
            return null;
        }
        // TLS attributes originate at the connector, not client forwarding headers.
        if (!request.isSecure()
                || !(request.getAttribute("jakarta.servlet.request.cipher_suite") instanceof String)) {
            throw new AccessRefused(403);
        }
        var origins = Collections.list(request.getHeaders("Origin"));
        if (origins.size() > 1 || (!origins.isEmpty() && !origin.equals(origins.getFirst()))) {
            throw new AccessRefused(403);
        }
        ViewerCredential credential;
        try {
            credential = ViewerCredential.read(Collections.list(request.getHeaders("Authorization")),
                    Collections.list(request.getHeaders("Cookie")), cookie);
        } catch (IllegalArgumentException invalid) {
            throw new AccessRefused(401);
        }
        if (credential == null) {
            throw new AccessRefused(401);
        }
        if (socket && credential.kind() == ViewerCredential.Kind.SESSION && origins.isEmpty()) {
            throw new AccessRefused(403);
        }
        return credential;
    }

    public AccessDecision authenticate(ViewerCredential credential) {
        return checked(strategy.authenticate(credential));
    }

    public AccessDecision authorise(ViewerCredential credential, ViewResource resource) {
        var decision = checked(strategy.authorise(credential, resource));
        if (decision instanceof AccessDecision.Granted allowed && !allowed.grant().permits(resource)) {
            return new AccessDecision.Rejected(AccessDecision.Reason.UNAVAILABLE);
        }
        return decision;
    }

    private AccessDecision checked(AccessDecision decision) {
        if (protectedMode()) {
            if (decision instanceof AccessDecision.Open) {
                return new AccessDecision.Rejected(AccessDecision.Reason.UNAVAILABLE);
            }
            if (decision instanceof AccessDecision.Granted allowed
                    && (!tenant.equals(allowed.grant().tenant()) || !allowed.grant().isCurrent())) {
                return new AccessDecision.Rejected(AccessDecision.Reason.UNAVAILABLE);
            }
        }
        return decision;
    }

    public static int status(AccessDecision.Rejected rejected) {
        return switch (rejected.reason()) {
            case UNAUTHENTICATED -> 401;
            case DENIED -> 403;
            case UNAVAILABLE -> 503;
        };
    }

    @PreDestroy
    public void close() {
        strategy.close();
    }
}
