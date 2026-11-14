package io.zooglass.runtime;

import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** One indexed deadline per selected field. Replacing a report removes its old deadline. */
final class FreshnessDeadlines {

    record Key(StateImage.ViewEntity entity, BoundView.Field field) {}

    private final Map<Key, Long> deadlines = new HashMap<>();
    private final TreeMap<Long, Set<Key>> byTime = new TreeMap<>();

    void replace(Key key, Long deadline) {
        var old = deadlines.remove(key);
        if (old != null) {
            var keys = byTime.get(old);
            keys.remove(key);
            if (keys.isEmpty()) {
                byTime.remove(old);
            }
        }
        if (deadline != null) {
            deadlines.put(key, deadline);
            byTime.computeIfAbsent(deadline, ignored -> new HashSet<>()).add(key);
        }
    }

    Long next() {
        return byTime.isEmpty() ? null : byTime.firstKey();
    }

    List<Key> due(long now) {
        // Stable enumeration must precede state transitions and subscriber notifications.
        return byTime.headMap(now, true).entrySet().stream()
                .flatMap(
                        entry ->
                                entry.getValue().stream()
                                        .sorted(
                                                Comparator.comparing(
                                                                (Key key) -> key.entity().viewId())
                                                        .thenComparing(
                                                                key -> key.entity().entityId())
                                                        .thenComparing(key -> key.field().name())))
                .toList();
    }
}
