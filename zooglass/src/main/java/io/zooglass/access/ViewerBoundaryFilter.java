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

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws IOException, ServletException {
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
