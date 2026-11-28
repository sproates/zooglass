package io.zooglass.runtime;

import org.springframework.http.HttpStatusCode;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import java.util.Arrays;
import java.util.Map;

final class HaHandshake implements HandshakeInterceptor {
    static final String PROTOCOL = "zooglass.ha.v1";
    static final String ATTEMPT = HaHandshake.class.getName() + ".attempt";
    private final HaOwner owners;

    HaHandshake(HaOwner owners) { this.owners = owners; }

    @Override
    public boolean beforeHandshake(ServerHttpRequest req, ServerHttpResponse res,
            WebSocketHandler handler, Map<String, Object> attributes) {
        res.getHeaders().setCacheControl("no-store");
        int status;
        if (!(req instanceof ServletServerHttpRequest servlet) || !"HTTP/1.1".equals(servlet.getServletRequest().getProtocol())) {
            status = 505;
        } else if (req.getHeaders().getOrEmpty("Sec-WebSocket-Protocol").stream()
                .flatMap(header -> Arrays.stream(header.split(","))).map(String::strip).noneMatch(PROTOCOL::equals)) {
            status = 406;
        } else {
            try {
                attributes.put(ATTEMPT, owners.use(null, owner -> {
                    if (!owner.servingReady()) throw HaOwner.unavailable();
                    return owner;
                }));
                return true;
            } catch (StorageUnavailable unavailable) { status = 503; }
        }
        res.setStatusCode(HttpStatusCode.valueOf(status));
        res.getHeaders().setContentLength(0);
        return false;
    }

    @Override
    public void afterHandshake(ServerHttpRequest req, ServerHttpResponse res, WebSocketHandler handler, Exception failure) {}
}
