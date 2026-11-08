package io.zooglass.access;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;

/** Local trusted producers use a separate credential, never a viewer policy grant. */
@Component
public final class OperatorAccess {

    static final String LISTENER = OperatorAccess.class.getName() + ".listener";
    private final ProtectedSettings settings;

    public OperatorAccess(Environment environment) {
        settings = ProtectedSettings.read(environment);
    }

    boolean enabled() { return settings != null; }
    int port() { return settings.operatorPort(); }

    public boolean listener(HttpServletRequest request) {
        return enabled() && request.getAttribute(LISTENER) == this;
    }

    public boolean permits(HttpServletRequest request) {
        if (!listener(request) || request.getHeader("Origin") != null) return false;
        var headers = Collections.list(request.getHeaders("Authorization"));
        if (headers.size() != 1) return false;
        return MessageDigest.isEqual(headers.getFirst().getBytes(StandardCharsets.UTF_8),
                ("Bearer " + settings.operatorToken()).getBytes(StandardCharsets.UTF_8));
    }

    public boolean route(HttpServletRequest request) {
        String path = request.getServletPath();
        return switch (path) {
            case "/events", "/progress", "/facts/retire", "/actuator/health" -> "GET".equals(request.getMethod());
            case "/views" -> "POST".equals(request.getMethod());
            default -> false;
        };
    }
}
