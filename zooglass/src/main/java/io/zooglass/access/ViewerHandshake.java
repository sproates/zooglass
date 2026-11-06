package io.zooglass.access;

import org.springframework.http.HttpStatusCode;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;

/** Authenticate before upgrade; identity alone grants no subscription. */
public final class ViewerHandshake implements HandshakeInterceptor {

    public static final String IDENTITY = ViewerHandshake.class.getName() + ".identity";
    private final AdmissionAccess access;

    public ViewerHandshake(AdmissionAccess access) {
        this.access = access;
    }

    public record Identity(ViewerCredential credential, String subject) {}

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
            WebSocketHandler handler, Map<String, Object> attributes) {
        if (!access.protectedMode()) {
            return true;
        }
        try {
            if (!(request instanceof ServletServerHttpRequest servlet)) {
                throw new AccessRefused(403);
            }
            var credential = access.credential(servlet.getServletRequest(), true);
            var decision = access.authenticate(credential);
            if (decision instanceof AccessDecision.Rejected rejected) {
                throw new AccessRefused(AdmissionAccess.status(rejected));
            }
            var grant = ((AccessDecision.Granted) decision).grant();
            attributes.put(IDENTITY, new Identity(credential, grant.subject()));
            return true;
        } catch (AccessRefused refused) {
            response.setStatusCode(HttpStatusCode.valueOf(refused.status()));
            return false;
        }
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
            WebSocketHandler handler, Exception exception) {}
}
