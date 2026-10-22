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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

@Component
public class LiveViewBroadcaster implements AutoCloseable {

    private static final Logger logger = LoggerFactory.getLogger(LiveViewBroadcaster.class);
    private static final int outboundQueueCapacity = 128;
    private static final CloseStatus slowClientCloseStatus = new CloseStatus(1013, "Live view client is too slow");

    private final ObjectMapper objectMapper;
    private final ViewStore viewStore;
    private final ExecutorService outboundExecutor = Executors.newVirtualThreadPerTaskExecutor();
    private final Map<Subscription, Set<WebSocketSession>> sessionsBySubscription = new HashMap<>();
    private final Map<WebSocketSession, Set<Subscription>> subscriptionsBySession = new HashMap<>();
    private final Map<WebSocketSession, SessionWriter> writersBySession = new HashMap<>();

    public LiveViewBroadcaster(ObjectMapper objectMapper, ViewStore viewStore) {
        this.objectMapper = objectMapper;
        this.viewStore = viewStore;
    }

    public synchronized void registerSession(WebSocketSession session) {
        writersBySession.computeIfAbsent(session, ignored -> new SessionWriter(session));
    }

    public synchronized void apply(String sourceId, String type, String entityId, JsonNode payload) {
        List<ViewSnapshot> updatedViews = viewStore.apply(sourceId, type, entityId, payload);
        for (ViewSnapshot snapshot : updatedViews) {
            Subscription subscription = new Subscription(snapshot.viewId(), snapshot.entityId());
            for (WebSocketSession session : List.copyOf(
                    sessionsBySubscription.getOrDefault(subscription, Set.of()))) {
                send(session, new ViewUpdate("view-update", snapshot.viewId(), snapshot.entityId(), snapshot.data()));
            }
        }
    }

    public synchronized boolean subscribe(WebSocketSession session, String viewId, String entityId) {
        if (!viewStore.containsView(viewId)) {
            return false;
        }

        Subscription subscription = new Subscription(viewId, entityId);
        sessionsBySubscription.computeIfAbsent(subscription, ignored -> new HashSet<>()).add(session);
        subscriptionsBySession.computeIfAbsent(session, ignored -> new HashSet<>()).add(subscription);
        send(session, new SubscriptionResponse("subscribed", viewId, entityId));
        viewStore.get(viewId, entityId).ifPresent(snapshot -> sendUpdate(session, snapshot));
        return true;
    }

    public synchronized void unsubscribe(WebSocketSession session, String viewId, String entityId) {
        Subscription subscription = new Subscription(viewId, entityId);
        removeSubscription(session, subscription);
        send(session, new SubscriptionResponse("unsubscribed", viewId, entityId));
    }

    public synchronized void removeSession(WebSocketSession session) {
        SessionWriter writer = writersBySession.remove(session);
        if (writer != null) {
            writer.stop();
        }

        Set<Subscription> subscriptions = subscriptionsBySession.remove(session);
        if (subscriptions == null) {
            return;
        }

        for (Subscription subscription : subscriptions) {
            Set<WebSocketSession> sessions = sessionsBySubscription.get(subscription);
            if (sessions != null) {
                sessions.remove(session);
                if (sessions.isEmpty()) {
                    sessionsBySubscription.remove(subscription);
                }
            }
        }
    }

    public synchronized void sendError(WebSocketSession session, String message) {
        send(session, new ClientError("error", message));
    }

    private void sendUpdate(WebSocketSession session, ViewSnapshot snapshot) {
        send(session, new ViewUpdate("view-update", snapshot.viewId(), snapshot.entityId(), snapshot.data()));
    }

    private void send(WebSocketSession session, Object message) {
        SessionWriter writer = writersBySession.get(session);
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

    private synchronized void handleWriteFailure(WebSocketSession session, SessionWriter writer, IOException exception) {
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

    private void removeSubscription(WebSocketSession session, Subscription subscription) {
        Set<WebSocketSession> sessions = sessionsBySubscription.get(subscription);
        if (sessions != null) {
            sessions.remove(session);
            if (sessions.isEmpty()) {
                sessionsBySubscription.remove(subscription);
            }
        }

        Set<Subscription> subscriptions = subscriptionsBySession.get(session);
        if (subscriptions != null) {
            subscriptions.remove(subscription);
            if (subscriptions.isEmpty()) {
                subscriptionsBySession.remove(session);
            }
        }
    }

    @Override
    public synchronized void close() {
        for (SessionWriter writer : writersBySession.values()) {
            writer.stop();
        }
        writersBySession.clear();
        subscriptionsBySession.clear();
        sessionsBySubscription.clear();
        outboundExecutor.shutdownNow();
    }

    private final class SessionWriter {

        private final WebSocketSession session;
        private final ArrayBlockingQueue<TextMessage> messages = new ArrayBlockingQueue<>(outboundQueueCapacity);
        private final Future<?> task;

        private SessionWriter(WebSocketSession session) {
            this.session = session;
            this.task = outboundExecutor.submit(this::writeMessages);
        }

        private boolean enqueue(TextMessage message) {
            return messages.offer(message);
        }

        private void stop() {
            task.cancel(true);
            messages.clear();
        }

        private void writeMessages() {
            try {
                while (session.isOpen()) {
                    session.sendMessage(messages.take());
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            } catch (IOException exception) {
                handleWriteFailure(session, this, exception);
            }
        }
    }

    private record Subscription(String viewId, String entityId) {
    }

    private record SubscriptionResponse(String type, String viewId, String entityId) {
    }

    private record ViewUpdate(String type, String viewId, String entityId, Map<String, JsonNode> data) {
    }

    private record ClientError(String type, String message) {
    }
}
