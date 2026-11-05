package io.zooglass.runtime;

import java.util.HashMap;
import java.util.HashSet;
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

    Set<Key> due(long now) {
        var keys = new HashSet<Key>();
        byTime.headMap(now, true).values().forEach(keys::addAll);
        return keys;
    }
}
