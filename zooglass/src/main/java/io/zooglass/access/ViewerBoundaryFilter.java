package io.zooglass.access;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/** A protected viewer listener has no publication, control, registration or management routes. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public final class ViewerBoundaryFilter extends OncePerRequestFilter {

    private final AdmissionAccess access;
    private final OperatorAccess operator;

    public ViewerBoundaryFilter(AdmissionAccess access, OperatorAccess operator) {
        this.operator = operator;
        this.access = access;
    }

    private boolean ha;

    @org.springframework.beans.factory.annotation.Autowired
    void deployment(org.springframework.core.env.Environment environment) {
        ha = "ha-static-v1".equals(environment.getProperty("zooglass.deployment.profile"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws IOException, ServletException {
        if (ha) {
            response.setHeader("Cache-Control", "no-store");
            String path = request.getServletPath();
            if ("/ha/ready".equals(path) && !operator.listener(request) && request.isSecure()) {
                request.setAttribute(io.zooglass.runtime.HaEndpoints.PROBE_DEADLINE,
                        System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2));
                chain.doFilter(request, response);
                return;
            }
            if (!access.protectedMode() && !("/views".equals(path) || path.startsWith("/views/")
                    || "/events".equals(path) || "/progress".equals(path) || "/facts/retire".equals(path))) {
                response.setStatus(403);
                return;
            }
        }
        if (!access.protectedMode()) {
            chain.doFilter(request, response);
            return;
        }
        response.setHeader("Cache-Control", "no-store");
        if (operator.listener(request)) {
            if (operator.permits(request) && operator.route(request)) chain.doFilter(request, response);
            else response.setStatus(403);
            return;
        }
        String path = request.getServletPath();
        if (!"GET".equals(request.getMethod())
                || !("/views".equals(path) || path.startsWith("/views/"))) {
            response.setStatus(403);
            return;
        }
        try {
            access.credential(request, "/views/live".equals(path));
            chain.doFilter(request, response);
        } catch (AccessRefused refused) {
            response.setStatus(refused.status());
        }
    }
}
