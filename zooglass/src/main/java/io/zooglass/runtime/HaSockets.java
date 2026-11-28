package io.zooglass.runtime;

import io.zooglass.access.*;
import io.zooglass.logging.ViewerLog;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;

/** Membership capture and publication fanout share the owner's operation gate. Writers perform their own admission. */
@Component
@HaDeployment
final class HaSockets implements WebSocketConfigurer {
    private final HaOwner owners;
    private final HaSettings settings;
    private final AdmissionAccess access;
    private final ConcurrentHashMap<WebSocketSession, HaPeer> peers = new ConcurrentHashMap<>();
    private final ActiveViewGrants grants;
    private final GrantRenewals renewals;

    HaSockets(HaOwner owners, HaSettings settings, AdmissionAccess access) {
        this.owners = owners;
        this.settings = settings;
        this.access = access;
        grants = new ActiveViewGrants(access, socket -> {
            var peer = peers.get(socket);
            if (peer != null) peer.stop(1008);
        });
        renewals = access.protectedMode() ? new GrantRenewals(grants) : null;
        owners.onRetirement(owner -> peers.values().forEach(peer -> {
            if (peer.owner == owner) peer.stop(1013);
        }));
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        var handshake = new HaHandshake(owners);
        registry.addHandler(new Endpoint(true), "/events").addInterceptors(handshake);
        var viewer = registry.addHandler(new Endpoint(false), "/views/live").addInterceptors(new ViewerHandshake(access), handshake);
        if (access.protectedMode()) viewer.setAllowedOrigins(access.origin());
    }

    private final class Endpoint extends TextWebSocketHandler implements SubProtocolCapable {
        final boolean source;
        Endpoint(boolean source) { this.source = source; }

        @Override
        public List<String> getSubProtocols() { return List.of(HaHandshake.PROTOCOL); }

        @Override
        public void afterConnectionEstablished(WebSocketSession socket) {
            var peer = new HaPeer(socket, source, owners, settings, access, grants, removed -> peers.remove(socket, removed));
            try {
                owners.use(peer.owner, owner -> {
                    peers.put(socket, peer);
                    if (peer.protectedViewer) grants.register(socket, peer.identity);
                    peer.delivery.start();
                    peer.reply(owner.hello(peer));
                    return null;
                });
            } catch (RuntimeException unavailable) { peer.stop(1013); }
        }

        @Override
        protected void handleTextMessage(WebSocketSession socket, TextMessage message) {
            var peer = peers.get(socket);
            if (peer == null) return;
            try {
                if (source) publication(peer, message.getPayload());
                else command(peer, message.getPayload());
            } catch (RuntimeException unavailable) { peer.stop(1013); }
        }

        @Override
        protected void handleBinaryMessage(WebSocketSession socket, BinaryMessage message) {
            var peer = peers.get(socket);
            if (peer != null) peer.stop(1003);
        }

        @Override
        public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
            var peer = peers.get(socket);
            if (peer != null) peer.stop(0);
        }

        @Override
        public void handleTransportError(WebSocketSession socket, Throwable error) {
            var peer = peers.get(socket);
            if (peer != null) peer.stop(1013);
        }
    }

    private void publication(HaPeer source, String wire) {
        Publication input;
        try { input = PublicationJson.parse(wire); }
        catch (RuntimeException invalid) {
            owners.use(source.owner, owner -> { if (source.live()) source.reply(owner.malformed(source)); return null; });
            return;
        }
        owners.use(source.owner, owner -> {
            if (!source.live()) return null;
            var result = owner.publication(source, input);
            source.reply(result.receipt());
            for (var change : result.changes()) {
                var resource = change.resource();
                for (var peer : peers.values()) {
                    var id = peer.memberships.get(resource);
                    if (peer.owner != owner || id == null || peer.closed.get()) continue;
                    var frame = change.forSubscription(peer, Long.toString(id));
                    peer.delivery.update(id, peer.pending(frame, peer.lease(resource), () -> id.equals(peer.memberships.get(resource))));
                }
            }
            return null;
        });
    }

    private void command(HaPeer peer, String wire) {
        HaCommand command;
        try { command = HaCommand.parse(wire); }
        catch (RuntimeException invalid) { invalid(peer); return; }
        if (!command.subscribe()) {
            owners.use(peer.owner, owner -> {
                if (!peer.memberships.remove(command.resource(), command.id())) {
                    peer.reply(owner.invalid(peer));
                    return null;
                }
                if (peer.protectedViewer) grants.remove(peer.socket, command.resource());
                peer.delivery.discardStale();
                peer.reply(owner.unsubscribed(peer, command.subscription(), command.resource()));
                return null;
            });
            return;
        }
        // The WebSocket container serialises incoming messages on one connection.
        if (command.id() <= peer.lastId || (peer.lastId == 0 && command.id() != 1)) { invalid(peer); return; }
        peer.lastId = command.id();
        var decision = access.authorise(peer.identity == null ? null : peer.identity.credential(), command.resource());
        if (decision instanceof AccessDecision.Rejected rejected) {
            if (!grants.refuse(peer.socket, command.resource())) {
                owners.use(peer.owner, owner -> {
                    peer.reply(owner.refusal(peer, command.subscription(), rejected.reason()));
                    return null;
                });
            }
            access.recordRejection(ViewerLog.Boundary.SUBSCRIPTION, rejected.reason());
            return;
        }
        var grant = decision instanceof AccessDecision.Granted allowed ? allowed.grant() : null;
        if (peer.protectedViewer && (grant == null || !peer.identity.subject().equals(grant.subject()))) { peer.stop(1008); return; }
        owners.use(peer.owner, owner -> {
            if (!peer.live()) return null;
            if (grant != null && !grant.permits(command.resource())) { peer.stop(1008); return null; }
            var opening = owner.opening(peer, command.subscription(), command.resource());
            if (opening.size() == 1) {
                peer.delivery.batch(List.of(peer.pending(opening.getFirst(), peer.lease(null), () -> grant == null || grant.permits(command.resource()))));
                return null;
            }
            if (grant != null && !grants.admit(peer.socket, command.resource(), grant)) { peer.stop(1008); return null; }
            peer.memberships.put(command.resource(), command.id());
            peer.delivery.discardStale();
            var lease = peer.lease(command.resource());
            BooleanSupplier current = () -> Long.valueOf(command.id()).equals(peer.memberships.get(command.resource()));
            peer.delivery.batch(opening.stream().map(frame -> peer.pending(frame, lease, current)).toList());
            return null;
        });
    }

    private void invalid(HaPeer peer) {
        owners.use(peer.owner, owner -> { peer.reply(owner.invalid(peer)); return null; });
    }

    @PreDestroy
    void close() {
        peers.values().forEach(peer -> peer.stop(1013));
        if (renewals != null) renewals.close();
    }
}
