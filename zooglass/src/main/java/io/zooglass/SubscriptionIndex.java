package io.zooglass;

import org.springframework.web.socket.WebSocketSession;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Both directions of subscription membership, guarded by the broadcaster's monitor. */
final class SubscriptionIndex {
    private final Map<Subscription, Set<WebSocketSession>> sessionsBySubscription = new HashMap<>();
    private final Map<WebSocketSession, Set<Subscription>> subscriptionsBySession = new HashMap<>();

    void add(WebSocketSession session, String viewId, String entityId) {
        var subscription = new Subscription(viewId, entityId);
        sessionsBySubscription.computeIfAbsent(subscription, ignored -> new HashSet<>()).add(session);
        subscriptionsBySession.computeIfAbsent(session, ignored -> new HashSet<>()).add(subscription);
    }

    List<WebSocketSession> recipients(String viewId, String entityId) {
        // Sending can remove a failed recipient; iteration must use a stable snapshot.
        return List.copyOf(sessionsBySubscription.getOrDefault(new Subscription(viewId, entityId), Set.of()));
    }

    void remove(WebSocketSession session, String viewId, String entityId) {
        var subscription = new Subscription(viewId, entityId);
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

    void removeSession(WebSocketSession session) {
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

    void clear() {
        subscriptionsBySession.clear();
        sessionsBySubscription.clear();
    }

    private record Subscription(String viewId, String entityId) {
    }
}
