package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Coordinates projection, subscription changes and queue insertion under one monitor. */
@Component
public class LiveViewBroadcaster implements AutoCloseable {

    private static final Logger logger = LoggerFactory.getLogger(LiveViewBroadcaster.class);
    private static final CloseStatus slowClientCloseStatus = new CloseStatus(1013, "Live view client is too slow");

    private final ObjectMapper objectMapper;
    private final ViewStore viewStore;
    private final ExecutorService outboundExecutor = Executors.newVirtualThreadPerTaskExecutor();
    private final SubscriptionIndex subscriptions = new SubscriptionIndex();
    private final Map<WebSocketSession, OutboundWriter> writersBySession = new HashMap<>();

    public LiveViewBroadcaster(ObjectMapper objectMapper, ViewStore viewStore) {
        this.objectMapper = objectMapper;
        this.viewStore = viewStore;
    }

    public synchronized void registerSession(WebSocketSession session) {
        writersBySession.computeIfAbsent(session, ignored -> new OutboundWriter(session, outboundExecutor,
                (writer, failure) -> handleWriteFailure(session, writer, failure)));
    }

    public synchronized void apply(String sourceId, String type, String entityId, JsonNode payload) {
        List<ViewSnapshot> updatedViews = viewStore.apply(sourceId, type, entityId, payload);
        for (ViewSnapshot snapshot : updatedViews) {
            for (WebSocketSession session : subscriptions.recipients(snapshot.viewId(), snapshot.entityId())) {
                send(session, new ViewUpdate("view-update", snapshot.viewId(), snapshot.entityId(), snapshot.data()));
            }
        }
    }

    public synchronized boolean subscribe(WebSocketSession session, String viewId, String entityId) {
        if (!viewStore.containsView(viewId)) {
            return false;
        }

        subscriptions.add(session, viewId, entityId);
        send(session, new SubscriptionResponse("subscribed", viewId, entityId));
        viewStore.get(viewId, entityId).ifPresent(snapshot -> sendUpdate(session, snapshot));
        return true;
    }

    public synchronized void unsubscribe(WebSocketSession session, String viewId, String entityId) {
        subscriptions.remove(session, viewId, entityId);
        send(session, new SubscriptionResponse("unsubscribed", viewId, entityId));
    }

    public synchronized void removeSession(WebSocketSession session) {
        OutboundWriter writer = writersBySession.remove(session);
        if (writer != null) {
            writer.stop();
        }

        subscriptions.removeSession(session);
    }

    public synchronized void sendError(WebSocketSession session, String message) {
        send(session, new ClientError("error", message));
    }

    private void sendUpdate(WebSocketSession session, ViewSnapshot snapshot) {
        send(session, new ViewUpdate("view-update", snapshot.viewId(), snapshot.entityId(), snapshot.data()));
    }

    private void send(WebSocketSession session, Object message) {
        OutboundWriter writer = writersBySession.get(session);
        if (writer == null || !session.isOpen()) {
            removeSession(session);
            return;
        }

        try {
            if (!writer.enqueue(new TextMessage(objectMapper.writeValueAsString(message)))) {
                logger.warn("Closing slow live view client {} after its outbound queue filled", session.getId());
                removeSession(session);
                closeSlowSession(session);
            }
        } catch (Exception exception) {
            logger.warn("Could not queue a live view message for client {}: {}", session.getId(), exception.getMessage());
            removeSession(session);
        }
    }

    private synchronized void handleWriteFailure(WebSocketSession session, OutboundWriter writer, IOException exception) {
        if (writersBySession.get(session) != writer) {
            return;
        }

        logger.warn("Could not send a live view message to client {}: {}", session.getId(), exception.getMessage());
        removeSession(session);
        closeSlowSession(session);
    }

    private static void closeSlowSession(WebSocketSession session) {
        Thread.startVirtualThread(() -> {
            try {
                if (session.isOpen()) {
                    session.close(slowClientCloseStatus);
                }
            } catch (IOException exception) {
                logger.warn("Could not close slow live view client {}: {}", session.getId(), exception.getMessage());
            }
        });
    }

    @Override
    public synchronized void close() {
        for (OutboundWriter writer : writersBySession.values()) {
            writer.stop();
        }
        writersBySession.clear();
        subscriptions.clear();
        outboundExecutor.shutdownNow();
    }

    private record SubscriptionResponse(String type, String viewId, String entityId) {
    }

    private record ViewUpdate(String type, String viewId, String entityId, Map<String, JsonNode> data) {
    }

    private record ClientError(String type, String message) {
    }
}
