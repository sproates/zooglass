package io.zooglass.runtime;

import java.time.Duration;
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

    synchronized Published publish(Publication input) {
        requireActive();
        var snapshots = new ArrayList<ViewCoordinator.Snapshot>();
        var detach = coordinator.listen(snapshots::add);
        try {
            var result = coordinator.apply(input);
            // New success is backed by its checked commit. Duplicates and refusals require a current capture.
            long revision = "committed".equals(result.status()) ? result.version() : store.capture();
            var receipt = capture(result, revision);
            var updates = snapshots.stream().map(snapshot -> capture(snapshot, revision)).toList();
            return new Published(receipt, updates);
        } catch (RuntimeException failure) {
            throw store.invalidate(failure);
        } finally {
            detach.run();
        }
    }

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
