package io.zooglass.access;

import org.springframework.core.env.Environment;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;

import java.net.URI;
import java.time.Duration;
import java.util.List;

/** Validates the complete deployment before a policy client or listener is created. */
record ProtectedSettings(PolicySettings policy, String origin, String cookie, int operatorPort, String operatorToken) {

    static ProtectedSettings read(Environment environment) {
        String mode = environment.getProperty("zooglass.access.mode", "openDemo");
        if ("openDemo".equals(mode)) {
            for (String key : List.of("tenant", "policy-url", "service-token", "origin", "session-cookie",
                    "timeout-ms", "max-concurrent", "operator-port", "operator-token")) {
                if (environment.containsProperty("zooglass.access." + key)) {
                    throw new IllegalArgumentException("Open demo access cannot have protected access settings");
                }
            }
            return null;
        }
        if (!"applicationPolicy".equals(mode)) {
            throw new IllegalArgumentException("Unknown zooglass.access.mode");
        }
        if (!environment.getProperty("server.ssl.enabled", Boolean.class, false)) {
            throw new IllegalArgumentException("Application policy requires direct TLS: server.ssl.enabled=true");
        }
        if (environment.getProperty("server.http2.enabled", Boolean.class, false)) {
            throw new IllegalArgumentException("Protected HTTP delivery requires server.http2.enabled=false");
        }
        if (!"none".equalsIgnoreCase(environment.getProperty("server.forward-headers-strategy"))) {
            throw new IllegalArgumentException("Protected deployment requires server.forward-headers-strategy=none");
        }
        if (environment.containsProperty("management.server.port")) {
            throw new IllegalArgumentException("Protected deployment uses the isolated operator listener for management");
        }
        // Boot can install RemoteIpValve from these settings even when the strategy
        // says none. Bind the aggregate so relaxed names and environment variables count.
        if (configured(environment, "server.tomcat.remoteip")) {
            throw new IllegalArgumentException("Protected deployment does not allow Tomcat remote-IP settings");
        }
        if (!"/actuator".equals(environment.getProperty("management.endpoints.web.base-path", "/actuator"))) {
            throw new IllegalArgumentException("Protected deployment requires management base path /actuator");
        }
        if (configured(environment, "management.endpoints.web.path-mapping")) {
            throw new IllegalArgumentException("Protected deployment does not allow management endpoint remapping");
        }
        var policy = new PolicySettings(required(environment, "tenant"),
                uri(required(environment, "policy-url")), required(environment, "service-token"),
                Duration.ofMillis(environment.getProperty("zooglass.access.timeout-ms", Long.class, 1000L)),
                environment.getProperty("zooglass.access.max-concurrent", Integer.class, 32));
        String origin = required(environment, "origin");
        String cookie = environment.getProperty("zooglass.access.session-cookie", "session");
        validateBrowser(origin, cookie);
        int port = Integer.parseInt(required(environment, "operator-port"));
        String token = required(environment, "operator-token");
        if (port < 0 || port > 65535) {
            throw new IllegalArgumentException("Operator port must be between 0 and 65535");
        }
        if (!ViewerCredential.validToken(token) || token.length() < 32) {
            throw new IllegalArgumentException("Operator token must contain at least 32 valid token characters");
        }
        if (token.equals(policy.serviceToken())) {
            throw new IllegalArgumentException("Operator and policy service tokens must differ");
        }
        return new ProtectedSettings(policy, origin, cookie, port, token);
    }

    static void validateBrowser(String origin, String cookie) {
        URI uri = uri(origin);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || !uri.getRawPath().isEmpty()
                || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Allowed browser origin must be an HTTPS origin");
        }
        ViewerCredential.read(List.of(), List.of(), cookie);
    }

    private static boolean configured(Environment environment, String prefix) {
        return !Binder.get(environment).bind(prefix, Bindable.mapOf(String.class, String.class))
                .orElse(java.util.Map.of()).isEmpty();
    }

    private static URI uri(String value) {
        try {
            return URI.create(value);
        } catch (IllegalArgumentException invalid) {
            throw new IllegalArgumentException("Invalid protected endpoint or origin URI");
        }
    }

    private static String required(Environment environment, String key) {
        return environment.getRequiredProperty("zooglass.access." + key);
    }

    @Override
    public String toString() { return "ProtectedSettings[secrets=redacted]"; }
}
