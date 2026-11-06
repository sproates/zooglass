package io.zooglass.access;

import org.springframework.web.socket.WebSocketSession;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** Connection-local grants. Policy I/O and socket callbacks never run under this monitor. */
public final class ActiveViewGrants {

    private final AdmissionAccess access;
    private final Consumer<WebSocketSession> onLoss;
    private final Map<WebSocketSession, Connection> connections = new HashMap<>();
    private boolean stopped;

    public ActiveViewGrants(AdmissionAccess access, Consumer<WebSocketSession> onLoss) {
        this.access = access;
        this.onLoss = onLoss;
    }

    public synchronized void register(WebSocketSession session, ViewerHandshake.Identity identity) {
        if (!stopped) {
            connections.putIfAbsent(session, new Connection(identity));
        }
    }

    /** Replacing a subscription creates a new generation, making older renewal replies obsolete. */
    public boolean admit(WebSocketSession session, ViewResource resource, AccessGrant grant) {
        synchronized (this) {
            var connection = connections.get(session);
            if (connection == null) {
                return false;
            }
            if (current(connection)) {
                if (!valid(connection, resource, grant)) {
                    return false;
                }
                connection.grants.put(resource, new Generation(grant));
                return true;
            }
            connections.remove(session);
        }
        onLoss.accept(session);
        return false;
    }

    public void remove(WebSocketSession session, ViewResource resource) {
        synchronized (this) {
            var connection = connections.get(session);
            if (connection == null) {
                return;
            }
            if (current(connection)) {
                connection.grants.remove(resource);
                return;
            }
            connections.remove(session);
        }
        onLoss.accept(session);
    }

    public synchronized void remove(WebSocketSession session) {
        connections.remove(session);
    }

    /** Expiry is checked even when no source publishes. One renewal may run per generation. */
    List<Renewal> due() {
        var losses = new ArrayList<WebSocketSession>();
        var work = new ArrayList<Renewal>();
        synchronized (this) {
            var iterator = connections.entrySet().iterator();
            while (iterator.hasNext()) {
                var entry = iterator.next();
                var connection = entry.getValue();
                if (!current(connection)) {
                    iterator.remove();
                    losses.add(entry.getKey());
                    continue;
                }
                connection.grants.forEach((resource, generation) -> {
                    if (!generation.renewing && generation.grant.renewalDue()) {
                        generation.renewing = true;
                        work.add(new Renewal(entry.getKey(), connection, resource, generation));
                    }
                });
            }
        }
        losses.forEach(onLoss);
        return work;
    }

    void renew(Renewal renewal) {
        synchronized (this) {
            if (!matches(renewal)) {
                return;
            }
        }
        AccessDecision decision;
        try {
            decision = access.authorise(renewal.connection.identity.credential(), renewal.resource);
        } catch (RuntimeException unavailable) {
            decision = new AccessDecision.Rejected(AccessDecision.Reason.UNAVAILABLE);
        }
        complete(renewal, decision);
    }

    void complete(Renewal renewal, AccessDecision decision) {
        boolean lost = false;
        synchronized (this) {
            if (!matches(renewal)) {
                return;
            }
            if (current(renewal.connection)
                    && decision instanceof AccessDecision.Granted allowed
                    && valid(renewal.connection, renewal.resource, allowed.grant())) {
                renewal.generation.grant = allowed.grant();
                renewal.generation.renewing = false;
            } else {
                connections.remove(renewal.session);
                lost = true;
            }
        }
        if (lost) {
            onLoss.accept(renewal.session);
        }
    }

    public synchronized void close() {
        stopped = true;
        connections.clear();
    }

    private boolean matches(Renewal renewal) {
        return connections.get(renewal.session) == renewal.connection
                && renewal.connection.grants.get(renewal.resource) == renewal.generation;
    }

    private boolean valid(Connection connection, ViewResource resource, AccessGrant grant) {
        return access.tenant().equals(grant.tenant())
                && connection.identity.subject().equals(grant.subject()) && grant.permits(resource);
    }

    private static boolean current(Connection connection) {
        return connection.grants.values().stream().allMatch(generation -> generation.grant.isCurrent());
    }

    static final class Renewal {
        private final WebSocketSession session;
        private final Connection connection;
        private final ViewResource resource;
        private final Generation generation;

        private Renewal(WebSocketSession session, Connection connection, ViewResource resource,
                Generation generation) {
            this.session = session;
            this.connection = connection;
            this.resource = resource;
            this.generation = generation;
        }
    }

    private static final class Connection {
        private final ViewerHandshake.Identity identity;
        private final Map<ViewResource, Generation> grants = new HashMap<>();

        private Connection(ViewerHandshake.Identity identity) {
            this.identity = identity;
        }
    }

    private static final class Generation {
        private AccessGrant grant;
        private boolean renewing;

        private Generation(AccessGrant grant) {
            this.grant = grant;
        }
    }
}
