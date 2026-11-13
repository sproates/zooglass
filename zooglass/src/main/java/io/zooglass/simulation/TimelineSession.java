package io.zooglass.simulation;

import org.springframework.http.HttpHeaders;
import org.springframework.web.socket.*;

import java.net.*;
import java.security.Principal;
import java.util.*;
import java.util.function.Consumer;

/** Modelled connection; only explicit transport effects reach the scenario actor. */
public final class TimelineSession implements WebSocketSession {
    private final String id;
    private final TurnContext turns;
    private final Consumer<String> receipt;
    private boolean open = true;

    public TimelineSession(String id, TurnContext turns, Consumer<String> receipt) {
        this.id = id;
        this.turns = turns;
        this.receipt = receipt;
    }

    public String getId() {
        return id;
    }

    public URI getUri() {
        return URI.create("ws://timeline.invalid/" + id);
    }

    public HttpHeaders getHandshakeHeaders() {
        return new HttpHeaders();
    }

    public Map<String, Object> getAttributes() {
        return Map.of();
    }

    public Principal getPrincipal() {
        return null;
    }

    public InetSocketAddress getLocalAddress() {
        return null;
    }

    public InetSocketAddress getRemoteAddress() {
        return null;
    }

    public String getAcceptedProtocol() {
        return null;
    }

    public void setTextMessageSizeLimit(int limit) {}

    public int getTextMessageSizeLimit() {
        return 16 * 1024 * 1024;
    }

    public void setBinaryMessageSizeLimit(int limit) {}

    public int getBinaryMessageSizeLimit() {
        return 0;
    }

    public List<WebSocketExtension> getExtensions() {
        return List.of();
    }

    public void sendMessage(WebSocketMessage<?> message) {
        turns.check();
        if (!open || !(message instanceof TextMessage text))
            throw new IllegalStateException("Unavailable connection");
        receipt.accept(text.getPayload());
    }

    public boolean isOpen() {
        turns.check();
        return open;
    }

    public void close() {
        close(CloseStatus.NORMAL);
    }

    public void close(CloseStatus status) {
        turns.check();
        open = false;
        turns.effect(Map.of("kind", "close", "session", id, "code", status.getCode()));
    }
}
