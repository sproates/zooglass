package io.zooglass.delivery;

import io.zooglass.access.ActiveViewGrants;

import jakarta.websocket.Session;

import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.adapter.NativeWebSocketSession;
import org.springframework.web.socket.handler.WebSocketSessionDecorator;

import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

/** One asynchronous transport submission at a time; completion waits hold no grant lock. */
final class AuthorisedSocketTransport {

    private final Session transport;
    private final WebSocketSession viewer;
    private final ActiveViewGrants grants;

    AuthorisedSocketTransport(WebSocketSession session, ActiveViewGrants grants) {
        var unwrapped = WebSocketSessionDecorator.unwrap(session);
        if (!(unwrapped instanceof NativeWebSocketSession nativeSession)
                || nativeSession.getNativeSession(Session.class) == null) {
            throw new IllegalArgumentException("Protected delivery requires a Jakarta WebSocket transport");
        }
        this.viewer = session;
        this.transport = nativeSession.getNativeSession(Session.class);
        this.grants = grants;
    }

    void send(OutboundQueue.Frame frame) throws IOException, InterruptedException {
        var remote = transport.getAsyncRemote();
        var completed = new CompletableFuture<Void>();
        boolean released = grants.release(viewer, frame.lease(), () -> remote.sendText(frame.message().getPayload(), result -> {
            if (result.isOK()) {
                completed.complete(null);
            } else {
                completed.completeExceptionally(result.getException());
            }
        }));
        if (!released) {
            return;
        }
        try {
            completed.get();
        } catch (ExecutionException failure) {
            throw new IOException("WebSocket transport failed", failure.getCause());
        }
    }
}
