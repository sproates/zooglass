package io.zooglass.runtime;

import io.zooglass.runtime.StateImage.Receipt;
import io.zooglass.runtime.StateImage.StoredView;
import io.zooglass.runtime.StateImage.StreamState;
import io.zooglass.runtime.StateImage.ViewEntity;
import io.zooglass.strategy.progress.ProgressRejected;
import io.zooglass.strategy.progress.ProgressStrategy;
import io.zooglass.strategy.progress.ProgressStrategySelection;

import jakarta.annotation.PreDestroy;

import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;
import java.util.function.Consumer;
import java.util.function.UnaryOperator;

/** Serialises admission, storage commits and snapshot reads. */
@Component
public final class ViewCoordinator implements AutoCloseable {

    private final Map<String, String> epochs;
    private final ViewTransitions views;
    private FactRetirementTransitions retirement;
    private boolean factsEnabled;
    private final Map<String, ProgressStrategy> progress;
    private final int maxStreams;
    private final int identityWindow;
    private final int historyLimit;
    private final StateStore storage;
    private final ReceiptClock clock;
    private FreshnessRuntime freshness;
    private RuntimeConfiguration configuration;
    private final List<Consumer<Snapshot>> listeners = new ArrayList<>();
    private boolean closed;

    @Autowired
    public ViewCoordinator(
            ResourceLoader resources,
            @Value("${zooglass.config:classpath:runtime-views.json}") String location,
            @Value("${zooglass.database:}") String database) {
        this(RuntimeConfiguration.load(resources, location), database);
    }

    public ViewCoordinator(RuntimeConfiguration configuration) {
        this(configuration, "");
    }

    ViewCoordinator(RuntimeConfiguration configuration, String database) {
        this(configuration, database, ReceiptClock.SYSTEM);
    }

    ViewCoordinator(RuntimeConfiguration configuration, String database, ReceiptClock clock) {
        this.clock = clock;
        this.configuration = configuration;
        configuration.validate();
        factsEnabled = configuration.tracksFacts();
        epochs = new HashMap<>();
        configuration.sources().forEach(source -> epochs.put(source.id(), source.epoch()));
        views = new ViewTransitions(configuration);
        retirement = new FactRetirementTransitions(configuration, views.byId());
        var policies = new HashMap<String, ProgressStrategy>();
        configuration
                .sources()
                .forEach(
                        source -> {
                            var settings = source.progress();
                            policies.put(
                                    source.id(),
                                    ProgressStrategySelection.select(
                                            settings.mode(),
                                            settings.startSequence(),
                                            settings.maxReceivedRanges(),
                                            settings.maxMissingRanges()));
                        });
        progress = Map.copyOf(policies);
        maxStreams = configuration.maxStreams();
        identityWindow = configuration.identityWindow();
        historyLimit = configuration.maxHistoryEntries();
        freshness =
                configuration.tracksAge()
                        ? new FreshnessRuntime(views.byId(), clock, this::expire)
                        : null;
        try {
            if (configuration.storage().equals("sqlite")) {
                storage =
                        new SqliteState(
                                database,
                                configuration,
                                freshness == null ? UnaryOperator.identity() : freshness::recover);
            } else {
                storage = new InMemoryState();
                if (freshness != null) {
                    storage.install(freshness.recover(storage.current()));
                }
            }
        } catch (RuntimeException failure) {
            if (freshness != null) {
                freshness.close();
            }
            throw failure;
        }
        if (freshness != null) {
            freshness.arm();
        }
    }

    public synchronized PublicationOutcome apply(Publication event) {
        expire();
        StateImage state = storage.current();
        String epoch = epochs.get(event.sourceId());

        if (epoch == null) {
            return rejected(event, "unknownSource");
        }
        if (!epoch.equals(event.epoch())) {
            return rejected(event, "unknownEpoch");
        }

        if (event.fact() != null && !factsEnabled) {
            return rejected(event, "factsNotConfigured");
        }
        StreamState stream = state.streams().get(event.stream());
        if (stream == null && state.streams().size() >= maxStreams) {
            return rejected(event, "streamLimit");
        }
        if (stream != null && event.publicationSequence() < stream.floor()) {
            return rejected(event, "outsideRetention");
        }

        Object content = PublicationJson.content(event.payload());
        Receipt previous =
                stream == null ? null : stream.receipts().get(event.publicationSequence());
        if (previous != null) {
            if (!Objects.equals(previous.fact(), event.fact())
                    || !previous.type().equals(event.type())
                    || !PublicationJson.content(previous.content()).equals(content)) {
                return rejected(event, "identityConflict");
            }
            return new PublicationOutcome(
                    "duplicate",
                    storage.durable() ? "alreadyCommitted" : "alreadyApplied",
                    event.stream(),
                    event.publicationSequence(),
                    previous.version(),
                    List.of(),
                    previous.targets());
        }

        try {
            FactOrigins.validate(event, state, views.byId());
            return stageAndInstall(event, stream);
        } catch (FactRejected exception) {
            return new PublicationOutcome(
                    "rejected",
                    exception.reason(),
                    event.stream(),
                    event.publicationSequence(),
                    state.version(),
                    List.of(),
                    exception.targets());
        } catch (ProgressRejected exception) {
            return rejected(event, exception.reason());
        } catch (ViewTransitions.PendingLimit exception) {
            return rejected(event, "pendingViewLimit");
        } catch (BoundView.CapacityExceeded exception) {
            return rejected(event, "historyLimit");
        }
    }

    private PublicationOutcome stageAndInstall(Publication event, StreamState stream) {
        StateImage state = storage.current();
        long version = Math.incrementExact(state.version());
        JsonNode contribution =
                JsonNodeFactory.instance
                        .objectNode()
                        .put("publicationSequence", event.publicationSequence())
                        .set("payload", event.payload().deepCopy());
        long floor =
                Math.max(
                        stream == null ? 1 : stream.floor(),
                        event.publicationSequence() - identityWindow + 1);
        var strategy = progress.get(event.sourceId());
        var nextProgress =
                strategy.receive(
                        stream == null ? strategy.initial() : stream.progress(),
                        event.publicationSequence(),
                        floor);
        var streams = new HashMap<>(state.streams());
        streams.put(
                event.stream(),
                new StreamState(
                        floor, stream == null ? Map.of() : stream.receipts(), nextProgress));
        var sample = clock.sample();
        var staged =
                views.stage(
                        state,
                        streams,
                        event.stream(),
                        event,
                        contribution,
                        historyLimit,
                        version,
                        sample.wall());

        var receipts = new TreeMap<Long, Receipt>();
        if (stream != null) {
            receipts.putAll(stream.receipts());
        }
        receipts.headMap(floor).clear();
        receipts.put(
                event.publicationSequence(),
                new Receipt(
                        event.type(),
                        event.payload().deepCopy(),
                        version,
                        staged.targets(),
                        event.fact()));
        streams.put(event.stream(), new StreamState(floor, Map.copyOf(receipts), nextProgress));

        // Build the response before the one installation point. No staged object escapes.
        var result =
                new PublicationOutcome(
                        storage.durable() ? "committed" : "applied",
                        storage.durable() ? "sqlite" : "memory",
                        event.stream(),
                        event.publicationSequence(),
                        version,
                        staged.changedViews(),
                        staged.targets());
        install(state, version, streams, staged, sample);
        return result;
    }

    synchronized ProgressOutcome advance(ProgressControl control) {
        expire();
        var state = storage.current();
        String epoch = epochs.get(control.sourceId());
        if (epoch == null) {
            return rejected(control, "unknownSource");
        }
        if (!epoch.equals(control.epoch())) {
            return rejected(control, "unknownEpoch");
        }
        var stream = state.streams().get(control.stream());
        if (stream == null && state.streams().size() >= maxStreams) {
            return rejected(control, "streamLimit");
        }
        var strategy = progress.get(control.sourceId());
        var previous = stream == null ? strategy.initial() : stream.progress();
        if (previous != null
                && previous.watermarkThrough() != null
                && control.throughSequence() == previous.watermarkThrough()) {
            return new ProgressOutcome(
                    "duplicate",
                    storage.durable() ? "alreadyCommitted" : "alreadyApplied",
                    control,
                    previous.watermarkVersion(),
                    List.of());
        }
        try {
            long version = Math.incrementExact(state.version());
            long floor = stream == null ? 1 : stream.floor();
            var nextProgress =
                    strategy.advance(previous, control.throughSequence(), version, floor);
            var streams = new HashMap<>(state.streams());
            streams.put(
                    control.stream(),
                    new StreamState(
                            floor, stream == null ? Map.of() : stream.receipts(), nextProgress));
            var sample = clock.sample();
            var staged =
                    views.stage(
                            state,
                            streams,
                            control.stream(),
                            null,
                            null,
                            historyLimit,
                            version,
                            sample.wall());
            var result =
                    new ProgressOutcome(
                            storage.durable() ? "committed" : "applied",
                            storage.durable() ? "sqlite" : "memory",
                            control,
                            version,
                            staged.changedViews());
            install(state, version, streams, staged, sample);
            return result;
        } catch (ProgressRejected rejection) {
            return rejected(control, rejection.reason());
        }
    }

    synchronized FactRetirementOutcome retire(FactRetirement control) {
        expire();
        var state = storage.current();
        try {
            long version = Math.incrementExact(state.version());
            var result = retirement.stage(state, control, version);
            if (result.staged() == null) {
                return new FactRetirementOutcome(
                        "factRetirement",
                        "unchanged",
                        null,
                        control,
                        state.version(),
                        result.floors(),
                        List.of());
            }
            install(state, version, result.streams(), result.staged(), clock.sample());
            return new FactRetirementOutcome(
                    "factRetirement",
                    storage.durable() ? "committed" : "applied",
                    null,
                    control,
                    version,
                    result.floors(),
                    result.staged().changedViews());
        } catch (FactRejected failure) {
            return FactRetirementOutcome.rejected(control, state.version(), failure.reason());
        }
    }

    private void install(
            StateImage old,
            long version,
            Map<Publication.StreamKey, StreamState> streams,
            ViewTransitions.Result staged,
            ReceiptClock.Sample sample) {
        var next =
                new StateImage(
                        version,
                        Map.copyOf(streams),
                        staged.views(),
                        freshness == null ? null : FreshnessRuntime.highWater(old, sample.wall()));
        if (freshness == null) {
            storage.install(next);
            publishChanges(old, storage.current());
            return;
        }
        var deadlines = freshness.plan(old, next, staged.touched(), sample.after());
        freshness.install(storage, old, next, sample);
        freshness.installed(deadlines);
        publishChanges(old, storage.current());
    }

    private synchronized void expire() {
        if (!closed && freshness != null) {
            var previous = storage.current();
            freshness.reconcile(storage);
            publishChanges(previous, storage.current());
        }
    }

    private ProgressOutcome rejected(ProgressControl control, String reason) {
        return new ProgressOutcome(
                "rejected", reason, control, storage.current().version(), List.of());
    }

    public synchronized Optional<Snapshot> snapshot(String viewId, String entityId) {
        expire();
        return snapshotOf(storage.current(), viewId, entityId);
    }

    private Optional<Snapshot> snapshotOf(StateImage state, String viewId, String entityId) {
        StoredView stored = state.views().get(new ViewEntity(viewId, entityId));
        var status = views.status(viewId, entityId, stored, state.streams());
        if (status == null) {
            return Optional.empty();
        }
        Map<String, JsonNode> copy = new LinkedHashMap<>();
        if (stored != null) {
            stored.data().forEach((key, value) -> copy.put(key, value.deepCopy()));
        }
        return Optional.of(
                new Snapshot(
                        viewId,
                        entityId,
                        stored == null ? 0 : stored.version(),
                        copy,
                        stored == null ? Map.of() : stored.provenance(),
                        status));
    }

    /** Called under this monitor. Listeners must only enqueue work, never perform network I/O. */
    public synchronized Runnable listen(Consumer<Snapshot> listener) {
        listeners.add(listener);
        return () -> {
            synchronized (this) {
                listeners.remove(listener);
            }
        };
    }

    public synchronized boolean containsView(String viewId) {
        return views.byId().containsKey(viewId);
    }

    /** Registration has no backfill; SQLite records the expanded configuration atomically. */
    public synchronized boolean define(RuntimeConfiguration.View definition) {
        if (definition == null) {
            throw new IllegalArgumentException("View definition is required");
        }
        var definitions = new ArrayList<>(configuration.views());
        definitions.add(definition);
        var next =
                new RuntimeConfiguration(
                        configuration.contractVersion(),
                        configuration.storage(),
                        maxStreams,
                        identityWindow,
                        historyLimit,
                        configuration.sources(),
                        List.copyOf(definitions));
        // Validate the body even when its name already exists, then distinguish a valid conflict.
        if (definition != null && containsView(definition.id())) {
            var single =
                    new RuntimeConfiguration(
                            next.contractVersion(),
                            next.storage(),
                            maxStreams,
                            identityWindow,
                            historyLimit,
                            next.sources(),
                            List.of(definition));
            single.validate();
            return false;
        }
        next.validate();
        var binding = ViewTransitions.bind(definition, next.sources());
        var nextRetirement = new FactRetirementTransitions(next, views.byId());
        FreshnessRuntime addedFreshness =
                freshness == null && next.tracksAge()
                        ? new FreshnessRuntime(views.byId(), clock, this::expire)
                        : null;
        try {
            storage.configure(
                    next,
                    addedFreshness == null ? UnaryOperator.identity() : addedFreshness::recover);
        } catch (RuntimeException failure) {
            if (addedFreshness != null) {
                addedFreshness.close();
            }
            throw failure;
        }
        views.add(binding);
        configuration = next;
        retirement = nextRetirement;
        factsEnabled = next.tracksFacts();
        if (addedFreshness != null) {
            freshness = addedFreshness;
            freshness.arm();
        }
        return true;
    }

    private void publishChanges(StateImage before, StateImage after) {
        if (listeners.isEmpty() || before == after) {
            return;
        }
        for (var entry : after.views().entrySet()) {
            var previous = before.views().get(entry.getKey());
            if (previous != null && previous.version() == entry.getValue().version()) {
                continue;
            }
            for (var listener : List.copyOf(listeners)) {
                try {
                    snapshotOf(after, entry.getKey().viewId(), entry.getKey().entityId())
                            .ifPresent(listener);
                } catch (RuntimeException failure) {
                    // Delivery cannot turn a committed publication into an uncommitted one.
                    LoggerFactory.getLogger(ViewCoordinator.class)
                            .warn(
                                    "Snapshot listener failed ({})",
                                    failure.getClass().getSimpleName());
                }
            }
        }
    }

    private PublicationOutcome rejected(Publication event, String reason) {
        return new PublicationOutcome(
                "rejected",
                reason,
                event.stream(),
                event.publicationSequence(),
                storage.current().version(),
                List.of());
    }

    synchronized boolean healthy() {
        try {
            storage.current();
            return true;
        } catch (IllegalStateException failure) {
            return false;
        }
    }

    @Override
    @PreDestroy
    public synchronized void close() {
        closed = true;
        listeners.clear();
        if (freshness != null) {
            freshness.close();
        }
        storage.close();
    }

    public record Snapshot(
            String viewId,
            String entityId,
            long version,
            Map<String, JsonNode> data,
            Map<String, Provenance> provenance,
            ViewStatus.Status status) {}
}
