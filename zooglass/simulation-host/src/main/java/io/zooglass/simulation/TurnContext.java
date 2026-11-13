package io.zooglass.simulation;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** POC-only turn ownership, clocks and opaque deferred callbacks. Never starts a worker. */
public final class TurnContext {
    static final long MAX_TIME_MS = 3_600_000;
    private final Thread owner = Thread.currentThread();
    private final Map<Long, Pending> pending = new LinkedHashMap<>();
    private final List<Map<String, Object>> effects = new ArrayList<>();
    private final HostTimingProbe timing = new HostTimingProbe();
    private boolean active;
    private long now;
    private long next;

    private record Pending(long at, String kind, Runnable action) {}

    public void begin(long at) {
        checkOwner();
        if (active || at < now || at > MAX_TIME_MS)
            throw new IllegalStateException("Invalid turn time");
        now = at;
        active = true;
    }

    public List<Map<String, Object>> end() {
        check();
        active = false;
        var result = List.copyOf(effects);
        effects.clear();
        return result;
    }

    public void check() {
        checkOwner();
        if (!active)
            throw new IllegalStateException("Semantic work outside turn");
    }

    private void checkOwner() {
        if (Thread.currentThread() != owner)
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
        Objects.requireNonNull(taskKind, "task kind");
        Objects.requireNonNull(action, "task action");
        long id = ++next;
        pending.put(id, new Pending(at, taskKind, action));
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
        var task = pending.get(id);
        if (task == null || task.at() != now)
            throw new IllegalStateException("Unknown or mistimed task");
        pending.remove(id);
        if (task.kind().equals("alarm")) perturb("alarm-dispatch");
        task.action().run();
    }

    public void effect(Map<String, Object> effect) {
        check();
        if ("state".equals(effect.get("kind"))) perturb("state-effect");
        effects.add(effect);
    }

    public void perturb(String site) {
        check();
        long before = now;
        timing.pause(site, before);
        check();
        if (now != before) throw new IllegalStateException("Host pause changed virtual time");
    }

    public Map<String, Object> diagnostics() { return timing.diagnostics(); }

    public int pendingCount() {
        check();
        return pending.size();
    }
}
