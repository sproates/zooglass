package io.zooglass.simulation;

import java.util.*;

/** POC-only turn ownership, clocks and opaque deferred callbacks. Never starts a worker. */
public final class TurnContext {
    private final Thread owner = Thread.currentThread();
    private final Map<Long, Pending> pending = new LinkedHashMap<>();
    private final List<Map<String, Object>> effects = new ArrayList<>();
    private boolean active;
    private long now;
    private long next;

    private record Pending(long at, Runnable action) {}

    public void begin(long at) {
        if (active || at < now || at > 3_600_000)
            throw new IllegalStateException("Invalid turn time");
        now = at;
        active = true;
        check();
    }

    public List<Map<String, Object>> end() {
        check();
        active = false;
        var result = List.copyOf(effects);
        effects.clear();
        return result;
    }

    public void check() {
        if (!active || Thread.currentThread() != owner)
            throw new IllegalStateException("Semantic work outside turn");
    }

    public long now() {
        check();
        return now;
    }

    public long schedule(long at, int phase, Runnable action) {
        return schedule(at, phase, "runtime", action);
    }

    public long schedule(long at, int phase, String taskKind, Runnable action) {
        check();
        if (at < now || phase < 0 || phase > 2 || pending.size() >= 1000)
            throw new IllegalStateException("Invalid task or task limit");
        long id = ++next;
        pending.put(id, new Pending(at, action));
        effect(
                Map.of(
                        "kind", "schedule", "task", id, "at", at, "phase", phase,
                        "taskKind", taskKind));
        return id;
    }

    public void cancel(long id) {
        check();
        if (pending.remove(id) != null) effect(Map.of("kind", "cancel", "task", id));
    }

    public void dispatch(long id) {
        check();
        var task = pending.remove(id);
        if (task == null || task.at() != now)
            throw new IllegalStateException("Unknown or mistimed task");
        task.action().run();
    }

    public void effect(Map<String, Object> effect) {
        check();
        effects.add(effect);
    }

    public int pendingCount() {
        check();
        return pending.size();
    }
}
