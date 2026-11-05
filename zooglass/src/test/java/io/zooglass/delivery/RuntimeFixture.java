package io.zooglass.delivery;

import io.zooglass.api.ViewSnapshot;
import io.zooglass.runtime.Publication;
import io.zooglass.runtime.PublicationJson;
import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.ViewCoordinator;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Creates source identities and reads the real coordinator; contains no reconciliation logic. */
final class RuntimeFixture implements AutoCloseable {
    private final ViewCoordinator runtime;
    private final Map<List<String>, Long> sequences = new HashMap<>();

    RuntimeFixture(ViewCases cases) {
        var sources = new HashSet<String>();
        var views =
                cases.views().stream()
                        .map(
                                view -> {
                                    var fields = new HashMap<String, RuntimeConfiguration.Field>();
                                    view.fields()
                                            .forEach(
                                                    (name, matchers) -> {
                                                        var inputs =
                                                                matchers.stream()
                                                                        .map(
                                                                                matcher -> {
                                                                                    sources.add(
                                                                                            matcher
                                                                                                    .sourceId());
                                                                                    return new RuntimeConfiguration
                                                                                            .Input(
                                                                                            matcher
                                                                                                    .sourceId(),
                                                                                            matcher
                                                                                                    .type());
                                                                                })
                                                                        .toList();
                                                        var ordering =
                                                                view.ordering() == null
                                                                        ? null
                                                                        : view.ordering().get(name);
                                                        fields.put(
                                                                name,
                                                                new RuntimeConfiguration.Field(
                                                                        null,
                                                                        null,
                                                                        ordering == null
                                                                                ? "arrival"
                                                                                : ordering.mode(),
                                                                        inputs,
                                                                        null));
                                                    });
                                    return new RuntimeConfiguration.View(view.id(), fields);
                                })
                        .toList();
        runtime =
                new ViewCoordinator(
                        new RuntimeConfiguration(
                                2,
                                "memory",
                                10_000,
                                10_000,
                                10_000,
                                sources.stream()
                                        .map(id -> new RuntimeConfiguration.Source(id, "test"))
                                        .toList(),
                                views));
    }

    ViewCoordinator runtime() {
        return runtime;
    }

    synchronized List<ObservedSnapshot> apply(
            String source, String type, String entity, JsonNode payload) {
        var key = List.of(source, entity);
        long next =
                payload.path("sequence").isIntegralNumber()
                        ? payload.path("sequence").longValue()
                        : sequences.getOrDefault(key, 0L) + 1;
        sequences.put(key, Math.max(next, sequences.getOrDefault(key, 0L)));
        synchronized (runtime) {
            var changes = new ArrayList<ObservedSnapshot>();
            var detach = runtime.listen(snapshot -> changes.add(observed(snapshot)));
            try {
                runtime.apply(
                        PublicationJson.parse(
                                new JsonMapper()
                                        .writeValueAsString(
                                                new Publication(
                                                        source, "test", entity, next, type,
                                                        payload))));
            } finally {
                detach.run();
            }
            return List.copyOf(changes);
        }
    }

    Optional<ObservedSnapshot> get(String view, String entity) {
        return runtime.snapshot(view, entity)
                .filter(snapshot -> snapshot.version() > 0)
                .map(RuntimeFixture::observed);
    }

    private static ObservedSnapshot observed(ViewCoordinator.Snapshot snapshot) {
        var response = ViewSnapshot.from(snapshot);
        return new ObservedSnapshot(response.viewId(), response.entityId(), response.data());
    }

    @Override
    public void close() {
        runtime.close();
    }
}
