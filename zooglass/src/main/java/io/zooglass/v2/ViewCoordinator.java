package io.zooglass.v2;

import io.zooglass.v2.InMemoryState.Image;
import io.zooglass.v2.InMemoryState.Receipt;
import io.zooglass.v2.InMemoryState.StoredView;
import io.zooglass.v2.InMemoryState.StreamState;
import io.zooglass.v2.InMemoryState.ViewEntity;
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
import java.util.Optional;
import java.util.TreeMap;

/** Serialises admission, staging and snapshot reads; installs one complete memory state. */
@Component
public final class ViewCoordinator {
    private final Map<String, String> epochs;
    private final List<BoundView> views;
    private final int maxStreams;
    private final int identityWindow;
    private final int historyLimit;
    private final InMemoryState storage = new InMemoryState();

    @Autowired
    public ViewCoordinator(ResourceLoader resources,
            @Value("${zooglass.v2.config:classpath:v2-views.json}") String location) {
        this(V2Configuration.load(resources, location));
    }

    ViewCoordinator(V2Configuration configuration) {
        configuration.validate();
        epochs = new HashMap<>();
        configuration.sources().forEach(source -> epochs.put(source.id(), source.epoch()));
        views = configuration.views().stream().map(BoundView::new).toList();
        maxStreams = configuration.maxStreams();
        identityWindow = configuration.identityWindow();
        historyLimit = configuration.maxHistoryEntries();
    }

    synchronized PublicationOutcome apply(Publication event) {
        Image state = storage.current();
        String epoch = epochs.get(event.sourceId());

        if (epoch == null) {
            return rejected(event, "unknownSource");
        }
        if (!epoch.equals(event.epoch())) {
            return rejected(event, "unknownEpoch");
        }

        StreamState stream = state.streams().get(event.stream());
        if (stream == null && state.streams().size() >= maxStreams) {
            return rejected(event, "streamLimit");
        }
        if (stream != null && event.publicationSequence() < stream.floor()) {
            return rejected(event, "outsideRetention");
        }

        Object content = PublicationJson.content(event.payload());
        Receipt previous = stream == null ? null : stream.receipts().get(event.publicationSequence());
        if (previous != null) {
            if (!previous.type().equals(event.type()) || !previous.content().equals(content)) {
                return rejected(event, "identityConflict");
            }
            return new PublicationOutcome("duplicate", "alreadyApplied", event.stream(),
                    event.publicationSequence(), previous.version(), List.of());
        }

        try {
            return stageAndInstall(event, stream, content);
        } catch (BoundView.CapacityExceeded exception) {
            return rejected(event, "historyLimit");
        }
    }

    private PublicationOutcome stageAndInstall(Publication event, StreamState stream, Object content) {
        Image state = storage.current();
        long version = Math.incrementExact(state.version());
        JsonNode contribution = JsonNodeFactory.instance.objectNode()
                .put("publicationSequence", event.publicationSequence())
                .set("payload", event.payload().deepCopy());
        Map<ViewEntity, StoredView> candidates = new HashMap<>(state.views());
        var changed = new ArrayList<String>();

        for (BoundView view : views) {
            ViewEntity key = new ViewEntity(view.id(), event.sourceEntityId());
            StoredView current = state.views().get(key);
            Map<String, JsonNode> update = view.evaluate(event, contribution,
                    current == null ? Map.of() : current.data(), historyLimit);
            if (update != null) {
                candidates.put(key, new StoredView(version, Map.copyOf(update)));
                changed.add(view.id());
            }
        }

        long floor = Math.max(stream == null ? 1 : stream.floor(),
                event.publicationSequence() - identityWindow + 1);
        var receipts = new TreeMap<Long, Receipt>();
        if (stream != null) {
            receipts.putAll(stream.receipts());
        }
        receipts.headMap(floor).clear();
        receipts.put(event.publicationSequence(), new Receipt(event.type(), content, version));
        var streams = new HashMap<>(state.streams());
        streams.put(event.stream(), new StreamState(floor, Map.copyOf(receipts)));

        // Build the response before the one installation point. No staged object escapes.
        var result = new PublicationOutcome("applied", "memory", event.stream(),
                event.publicationSequence(), version, List.copyOf(changed));
        Image next = new Image(version, Map.copyOf(streams), Map.copyOf(candidates));
        storage.install(next);
        return result;
    }

    public synchronized Optional<Snapshot> snapshot(String viewId, String entityId) {
        if (views.stream().noneMatch(view -> view.id().equals(viewId))) {
            return Optional.empty();
        }
        StoredView stored = storage.current().views().get(new ViewEntity(viewId, entityId));
        Map<String, JsonNode> copy = new LinkedHashMap<>();
        if (stored != null) {
            stored.data().forEach((key, value) -> copy.put(key, value.deepCopy()));
        }
        return Optional.of(new Snapshot(viewId, entityId, stored == null ? 0 : stored.version(), copy));
    }

    private PublicationOutcome rejected(Publication event, String reason) {
        return new PublicationOutcome("rejected", reason, event.stream(), event.publicationSequence(),
                storage.current().version(), List.of());
    }

    public record Snapshot(String viewId, String entityId, long version, Map<String, JsonNode> data) {}
}
