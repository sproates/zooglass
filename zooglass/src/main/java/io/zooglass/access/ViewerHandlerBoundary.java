package io.zooglass.access;

import io.zooglass.runtime.RuntimeEndpoints;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.handler.MappedInterceptor;
import org.springframework.web.socket.server.support.WebSocketHttpRequestHandler;

/** Checks the selected handler, including Actuator mappings relocated under /views. */
@Configuration(proxyBeanMethods = false)
public class ViewerHandlerBoundary {

    @Bean
    MappedInterceptor viewerHandlers(AdmissionAccess access) {
        // A mapped interceptor also applies to non-MVC handler mappings such as Actuator.
        return new MappedInterceptor(null, new HandlerInterceptor() {
            @Override
            public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                    Object handler) {
                if (!access.protectedMode() || isViewer(handler)) {
                    return true;
                }
                response.setHeader("Cache-Control", "no-store");
                response.setStatus(403);
                return false;
            }
        });
    }

    private static boolean isViewer(Object handler) {
        // Only the viewer socket is registered on a protected listener; its handshake
        // interceptor authenticates before upgrade.
        if (handler instanceof WebSocketHttpRequestHandler) {
            return true;
        }
        if (handler instanceof HandlerMethod method && method.getBeanType() == RuntimeEndpoints.class) {
            return method.getMethod().getName().equals("lookup")
                    || method.getMethod().getName().equals("snapshot");
        }
        return false;
    }
}
