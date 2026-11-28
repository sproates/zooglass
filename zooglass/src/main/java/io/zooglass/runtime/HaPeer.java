package io.zooglass.runtime;

import io.zooglass.access.ActiveViewGrants;
import io.zooglass.access.AdmissionAccess;
import io.zooglass.access.ViewResource;
import io.zooglass.access.ViewerHandshake;
import io.zooglass.delivery.HaDelivery;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/** Identity, membership generations and bounded delivery belong to a single upgraded socket. */
final class HaPeer {
    private final HaOwner owners;
    private final ActiveViewGrants grants;
    private final java.util.function.Consumer<HaPeer> detach;

    final WebSocketSession socket;
    final OwnedRuntime owner;
    final boolean protectedViewer;
    final ViewerHandshake.Identity identity;
    final ConcurrentHashMap<ViewResource, Long> memberships = new ConcurrentHashMap<>();
    final HaDelivery delivery;
    final AtomicBoolean closed = new AtomicBoolean();
    long lastId;

    HaPeer(WebSocketSession socket, boolean source, HaOwner owners, HaSettings settings, AdmissionAccess access,
            ActiveViewGrants grants, java.util.function.Consumer<HaPeer> detach) {
        this.owners = owners;
        this.grants = grants;
        this.detach = detach;
        this.socket = socket;
        this.owner = (OwnedRuntime) java.util.Objects.requireNonNull(socket.getAttributes().get(HaHandshake.ATTEMPT));
        this.identity = (ViewerHandshake.Identity) socket.getAttributes().get(ViewerHandshake.IDENTITY);
        protectedViewer = access.protectedMode() && !source;
        if (protectedViewer) java.util.Objects.requireNonNull(identity);
        delivery = new HaDelivery(settings.profile.configuration().delivery(), socket, protectedViewer ? grants : null, this::stop);
    }

    void stop(int code) {
        if (!closed.compareAndSet(false, true)) return;
        detach.accept(this);
        grants.remove(socket);
        memberships.clear();
        delivery.stop();
        if (code != 0) Thread.startVirtualThread(() -> {
            try {
                socket.close(new CloseStatus(code));
            } catch (IOException | RuntimeException ignored) {
                // Membership and waiting work have already been retired.
            }
        });
    }

    boolean live() { return !closed.get() && owners.current(owner); }
    ActiveViewGrants.Lease lease(ViewResource resource) { return protectedViewer ? grants.capture(socket, resource) : null; }

    HaDelivery.Pending pending(OwnedRuntime.Frame frame, ActiveViewGrants.Lease lease, BooleanSupplier membership) {
        return new HaDelivery.Pending(frame.maximumBytes(), lease, () -> live() && membership.getAsBoolean(),
                () -> owners.use(owner, active -> frame.admit(this)));
    }

    void reply(OwnedRuntime.Frame frame) { delivery.batch(List.of(pending(frame, lease(null), () -> true))); }
}

