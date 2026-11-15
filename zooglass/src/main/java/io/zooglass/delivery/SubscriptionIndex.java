package io.zooglass.delivery;

import org.springframework.web.socket.WebSocketSession;

import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Both directions of subscription membership, guarded by the broadcaster's monitor. */
final class SubscriptionIndex {

    private long nextGeneration;
    private final Map<Subscription, Map<WebSocketSession, Long>> sessionsBySubscription =
            new HashMap<>();
    private final Map<WebSocketSession, Set<Subscription>> subscriptionsBySession = new HashMap<>();

    void add(WebSocketSession session, String viewId, String entityId) {
        var subscription = new Subscription(viewId, entityId);
        sessionsBySubscription
                .computeIfAbsent(subscription, ignored -> new LinkedHashMap<>())
                .put(session, ++nextGeneration);
        subscriptionsBySession
                .computeIfAbsent(session, ignored -> new HashSet<>())
                .add(subscription);
    }

    boolean hasRecipients(String viewId, String entityId) {
        return sessionsBySubscription.containsKey(new Subscription(viewId, entityId));
    }

    Map<WebSocketSession, Long> recipients(String viewId, String entityId) {
        // Sending can remove a failed recipient; iteration must use a stable snapshot.
        return Collections.unmodifiableMap(
                new LinkedHashMap<>(
                        sessionsBySubscription.getOrDefault(
                                new Subscription(viewId, entityId), Map.of())));
    }

    void remove(WebSocketSession session, String viewId, String entityId) {
        var subscription = new Subscription(viewId, entityId);
        var sessions = sessionsBySubscription.get(subscription);
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
            var sessions = sessionsBySubscription.get(subscription);
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

    private record Subscription(String viewId, String entityId) {}
}
