package io.zooglass.access;

import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.util.Collections;

/** Shared HTTP/handshake admission using the configured access strategy. */
@Component
public final class AdmissionAccess {

    private final ViewerAccess strategy;
    private final String tenant;
    private final String origin;
    private final String cookie;

    @Autowired
    public AdmissionAccess(Environment environment) {
        var settings = ProtectedSettings.read(environment);
        if (settings == null) {
            strategy = AccessStrategySelection.select(AccessStrategySelection.Mode.OPEN_DEMO, null);
            tenant = null;
            origin = null;
            cookie = null;
        } else {
            strategy = AccessStrategySelection.select(AccessStrategySelection.Mode.APPLICATION_POLICY, settings.policy());
            tenant = settings.policy().tenant();
            origin = settings.origin();
            cookie = settings.cookie();
        }
    }

    public AdmissionAccess() {
        this.strategy = AccessStrategySelection.select(AccessStrategySelection.Mode.OPEN_DEMO, null);
        this.tenant = null;
        this.origin = null;
        this.cookie = null;
    }

    AdmissionAccess(ViewerAccess strategy, String tenant, String origin, String cookie) {
        ProtectedSettings.validateBrowser(origin, cookie);
        if (tenant == null || tenant.isBlank() || !tenant.equals(tenant.strip())) {
            throw new IllegalArgumentException("A tenant ID is required");
        }
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
