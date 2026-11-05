package io.zooglass.strategy.update;

import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Holds independent field states while the actual strategies evaluate each input. */
final class OrderingFixture {
    record Snapshot(String viewId, String entityId, Map<String, JsonNode> data) {}

    private final Map<List<String>, Map<String, JsonNode>> states = new HashMap<>();
    private final Map<String, FieldUpdateStrategy> strategies =
            Map.of(
                    "latest", new LatestBySequence("sequence"),
                    "history", new HistoryBySequence("sequence"));

    List<Snapshot> apply(String source, String type, String entity, JsonNode payload) {
        if (!type.equals("position") || !List.of("primary-feed", "backup-feed").contains(source)) {
            return List.of();
        }
        var changes = new ArrayList<Snapshot>();
        strategies.forEach(
                (view, strategy) -> {
                    var key = List.of(view, entity);
                    var before = states.getOrDefault(key, Map.of());
                    var after = new HashMap<>(before);
                    for (String field :
                            List.of(
                                    source.equals("primary-feed") ? "primary" : "backup",
                                    "shared")) {
                        var update = strategy.evaluate(before.get(field), payload);
                        if (update.changed()) after.put(field, update.replacement());
                    }
                    if (!after.equals(before)) {
                        states.put(key, Map.copyOf(after));
                        changes.add(new Snapshot(view, entity, Map.copyOf(after)));
                    }
                });
        return changes;
    }

    Optional<Snapshot> get(String view, String entity) {
        return Optional.ofNullable(states.get(List.of(view, entity)))
                .map(data -> new Snapshot(view, entity, data));
    }
}
