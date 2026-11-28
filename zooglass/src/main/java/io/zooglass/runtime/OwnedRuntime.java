package io.zooglass.runtime;

import io.zooglass.access.ViewResource;
import io.zooglass.api.ViewSnapshot;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Consumer;

/** Internal owner interface. Captures have no public bytes; an authority transaction admits one immutable handoff. */
final class OwnedRuntime implements AutoCloseable {
    static final class Content {
        private final PostgresAuthority.Identity owner;
        private final long revision;
        private final String body;
        private boolean used;

        private Content(PostgresAuthority.Identity owner, long revision, Object actualContent) {
            this.owner = owner;
            this.revision = revision;
            this.body = StateRowJson.JSON.writeValueAsString(actualContent);
        }
    }

    record Published(Content receipt, List<Content> updates) {}
    record Admission(UUID incarnation, String generation, String contentRevision, String authorityRevision, String body) {}

    private final PostgresState store;
    private final ViewCoordinator.HaFactory factory;
    private ViewCoordinator coordinator;
    private boolean active;

    OwnedRuntime(ViewCoordinator.HaFactory factory, PostgresState.Connections connections, Duration lease) {
        this.factory = Objects.requireNonNull(factory);
        this.store = new PostgresState(factory.profile, connections, lease);
    }

    synchronized void recover() {
        if (coordinator != null) throw new IllegalStateException("Coordinator already recovered");
        store.recover();
        try {
            coordinator = factory.build(store);
        } catch (RuntimeException failure) {
            throw store.invalidate(failure);
        }
    }

    synchronized void activate() {
        if (active || coordinator == null) throw new IllegalStateException("Recover the coordinator before activation");
        store.activate();
        active = true;
    }

    synchronized void renew() {
        store.renew();
    }

    synchronized boolean servingReady() {
        if (!active) return false;
        try {
            store.capture();
            return true;
        } catch (StorageUnavailable unavailable) {
            return false;
        }
    }

    private record Transition(PublicationOutcome outcome, long revision, List<ViewCoordinator.Snapshot> updates) {}

    private Transition reconcile(Publication input) {
        requireActive();
        var snapshots = new ArrayList<ViewCoordinator.Snapshot>();
        var detach = coordinator.listen(snapshots::add);
        try {
            var result = coordinator.apply(input);
            long revision = "committed".equals(result.status()) ? result.version() : store.capture();
            return new Transition(result, revision, snapshots);
        } finally {
            detach.run();
        }
    }

    synchronized Published publish(Publication input) {
        requireActive();
        try {
            var result = reconcile(input);
            return new Published(capture(result.outcome, result.revision),
                    result.updates.stream().map(snapshot -> capture(snapshot, result.revision)).toList());
        } catch (RuntimeException failure) {
            throw store.invalidate(failure);
        }
    }

    /** Fully serialised public payload, unexposed until a particular recipient obtains a permit. */
    final class Frame {
        private final Object recipient;
        private final String kind;
        private final Content content;
        private final int maximumBytes;

        private Frame(Object recipient, String kind, Object payload, long revision) {
            this.recipient = recipient;
            this.kind = kind;
            content = capture(payload, revision);
            maximumBytes = "accessRefusal".equals(kind) ? content.body.getBytes(StandardCharsets.UTF_8).length
                    : Math.addExact(envelope("").getBytes(StandardCharsets.UTF_8).length, 19);
        }

        int maximumBytes() { return maximumBytes; }
        String kind() { return kind; }

        private String envelope(String authority) {
            if ("accessRefusal".equals(kind)) return content.body;
            return "{\"kind\":\"" + kind + "\",\"incarnation\":\"" + content.owner.incarnation()
                    + "\",\"generation\":\"" + content.owner.generation() + "\",\"contentRevision\":\"" + content.revision
                    + "\",\"authorityRevision\":\"" + authority + "\",\"payload\":" + content.body + "}";
        }

        String admit(Object destination) {
            if (recipient != destination) throw new IllegalStateException("Different HA recipient");
            var authority = new String[1];
            handoff(content, admission -> authority[0] = admission.authorityRevision());
            return envelope(authority[0]);
        }
    }

    final class Change {
        private final ViewSnapshot snapshot;
        private final long revision;

        private Change(ViewCoordinator.Snapshot snapshot, long revision) {
            this.snapshot = ViewSnapshot.from(snapshot);
            this.revision = revision;
        }

        ViewResource resource() { return new ViewResource(snapshot.viewId(), snapshot.entityId()); }

        Frame forSubscription(Object recipient, String subscription) {
            return new Frame(recipient, "update", Map.of("subscription", subscription, "snapshot", snapshot), revision);
        }
    }

    record PublicationFrames(Frame receipt, List<Change> changes) {}

    synchronized PublicationFrames publication(Object source, Publication input) {
        requireActive();
        try {
            var result = reconcile(input);
            return new PublicationFrames(new Frame(source, "receipt", result.outcome, result.revision),
                    result.updates.stream().map(snapshot -> new Change(snapshot, result.revision)).toList());
        } catch (RuntimeException failure) {
            throw store.invalidate(failure);
        }
    }

    synchronized Frame hello(Object destination) {
        return new Frame(destination, "hello", Map.of(), store.capture());
    }

    synchronized Frame malformed(Object destination) {
        return new Frame(destination, "receipt", PublicationOutcome.malformed(), store.capture());
    }

    synchronized Frame snapshotFrame(Object destination, ViewResource resource) {
        long revision = store.capture();
        return coordinator.snapshot(resource.viewId(), resource.entityId()).map(snapshot ->
                new Frame(destination, "snapshot", ViewSnapshot.from(snapshot), revision))
                .orElseGet(() -> new Frame(destination, "notFound", Map.of(), revision));
    }

    synchronized List<Frame> opening(Object destination, String id, ViewResource resource) {
        long revision = store.capture();
        var snapshot = coordinator.snapshot(resource.viewId(), resource.entityId());
        if (snapshot.isEmpty()) {
            return List.of(new Frame(destination, "requestError", Map.of("code", "unknownView", "subscription", id), revision));
        }
        return List.of(new Frame(destination, "subscribed", Map.of("subscription", id, "viewId", resource.viewId(),
                        "entityId", resource.entityId(), "recovery", "freshSnapshot"), revision),
                new Frame(destination, "baseline", Map.of("subscription", id, "snapshot", ViewSnapshot.from(snapshot.get())), revision));
    }

    synchronized Frame refusal(Object destination, String id, io.zooglass.access.AccessDecision.Reason reason) {
        String code = reason == io.zooglass.access.AccessDecision.Reason.UNAVAILABLE ? "accessUnavailable" : "accessDenied";
        return new Frame(destination, "accessRefusal", Map.of("error", code, "subscription", id), store.capture());
    }

    synchronized Frame unsubscribed(Object destination, String id, ViewResource resource) {
        return new Frame(destination, "unsubscribed", Map.of("subscription", id, "viewId", resource.viewId(),
                "entityId", resource.entityId()), store.capture());
    }

    synchronized Frame invalid(Object destination) {
        return new Frame(destination, "requestError", StateRowJson.JSON.createObjectNode()
                .put("code", "invalidRequest").putNull("subscription"), store.capture());
    }

    synchronized void probe(long deadline) { requireActive(); store.probe(deadline); }

    /** Called only by the deadline watchdog for the probe holding the exclusive service gate. */
    void abortProbe() { store.abortProbe(); }

    synchronized Content snapshot(String viewId, String entityId) {
        requireActive();
        long revision = store.capture();
        return capture(coordinator.snapshot(viewId, entityId).orElse(null), revision);
    }

    synchronized Content advance(ProgressControl control) {
        requireActive();
        long revision = store.capture();
        return capture(coordinator.advance(control), revision);
    }

    synchronized Content retire(FactRetirement control) {
        requireActive();
        long revision = store.capture();
        return capture(coordinator.retire(control), revision);
    }

    private Content capture(Object actualContent, long revision) {
        return new Content(store.identity(), revision, actualContent);
    }

    private void requireActive() {
        if (!active) throw new StorageUnavailable("Runtime is not active", null);
        store.current();
    }

    void handoff(Content content, Consumer<Admission> recipient) {
        Objects.requireNonNull(recipient);
        Admission admitted;
        synchronized (this) {
            requireActive();
            var owner = store.identity();
            if (content.owner != owner || content.used) {
                throw new IllegalStateException("Different generation or previously consumed content");
            }
            long revision = store.admit(content.revision);
            content.used = true;
            admitted = new Admission(owner.incarnation(), Long.toString(owner.generation()),
                    Long.toString(content.revision), Long.toString(revision), content.body);
        }
        recipient.accept(admitted);
    }

    @Override
    public synchronized void close() {
        active = false;
        if (coordinator == null) store.close();
        else coordinator.close();
    }
}
