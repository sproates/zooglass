package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Component
public class LiveViewBroadcaster {

    private static final Logger logger = LoggerFactory.getLogger(LiveViewBroadcaster.class);

    private final ObjectMapper objectMapper;
    private final ViewStore viewStore;
    private final Map<Subscription, Set<WebSocketSession>> sessionsBySubscription = new HashMap<>();
    private final Map<WebSocketSession, Set<Subscription>> subscriptionsBySession = new HashMap<>();

    public LiveViewBroadcaster(ObjectMapper objectMapper, ViewStore viewStore) {
        this.objectMapper = objectMapper;
        this.viewStore = viewStore;
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
        if (!session.isOpen()) {
            removeSession(session);
            return;
        }

        try {
            session.sendMessage(new TextMessage(objectMapper.writeValueAsString(message)));
        } catch (IOException exception) {
            logger.warn("Could not send a live view message to client {}: {}", session.getId(), exception.getMessage());
            removeSession(session);
        }
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

    private record Subscription(String viewId, String entityId) {
    }

    private record SubscriptionResponse(String type, String viewId, String entityId) {
    }

    private record ViewUpdate(String type, String viewId, String entityId, Map<String, JsonNode> data) {
    }

    private record ClientError(String type, String message) {
    }
}
