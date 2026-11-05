package io.zooglass.v2;

import io.zooglass.strategy.contribution.SelectedContribution;
import io.zooglass.v2.StateImage.StoredView;
import io.zooglass.v2.StateImage.ViewEntity;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Called under the coordinator lock. The single alarm only wakes the coordinator. */
final class FreshnessRuntime implements AutoCloseable {
    private final Map<String, BoundView> bindings;
    private final ReceiptClock clock;
    private final FreshnessDeadlines deadlines = new FreshnessDeadlines();
    private final ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(1,
            Thread.ofPlatform().daemon().name("zooglass-receipt-age").factory());
    private final Runnable wake;
    private ScheduledFuture<?> alarm;
    private Long armed;
    private final ClockRollback observations = new ClockRollback();

    FreshnessRuntime(Map<String, BoundView> bindings, ReceiptClock clock, Runnable wake) {
        this.bindings = bindings;
        this.clock = clock;
        this.wake = wake;
        timer.setRemoveOnCancelPolicy(true);
    }

    StateImage recover(StateImage old) {
        var sample = clock.sample();
        long wall = sample.wall();
        long monotonic = sample.after();
        boolean rollback = old.lastWallMillis() != null && wall < old.lastWallMillis();
        var rows = new HashMap<>(old.views());
        boolean dirty = false;
        for (var entry : old.views().entrySet()) {
            var key = entry.getKey();
            var row = entry.getValue();
            for (var field : bindings.get(key.viewId()).fields()) {
                var sources = row.candidates().get(field.name());
                if (sources == null) continue;
                var winner = field.selected(row);
                for (var source : sources.entrySet()) {
                    var saved = source.getValue();
                    var age = field.freshness().recovered(saved.age(), wall, rollback);
                    if (!Objects.equals(age, saved.age())) {
                        long version = saved == winner ? Math.incrementExact(old.version()) : row.version();
                        row = row.replaceCandidate(field.name(), source.getKey(), saved.withAge(age), version);
                        dirty = true;
                    }
                }
                var selected = field.selected(row);
                var age = selected.age();
                long elapsed = age == null || age.receivedAtMillis() == null ? 0 : wall - age.receivedAtMillis();
                deadlines.replace(new FreshnessDeadlines.Key(key, field), deadline(field, selected, elapsed, monotonic));
            }
            rows.put(key, row);
        }
        long observed = highWater(old, wall);
        observations.start(sample);
        if (dirty || !Objects.equals(old.lastWallMillis(), observed)) {
            long version = dirty ? Math.incrementExact(old.version()) : old.version();
            return new StateImage(version, old.streams(), Map.copyOf(rows), observed);
        }
        return old;
    }

    static long highWater(StateImage previous, long wall) {
        return previous.lastWallMillis() == null ? wall : Math.max(previous.lastWallMillis(), wall);
    }

    Map<FreshnessDeadlines.Key, Long> plan(StateImage old, StateImage next, List<ViewEntity> touched, long monotonic) {
        var replacements = new HashMap<FreshnessDeadlines.Key, Long>();
        for (var key : touched) {
            for (var field : bindings.get(key.viewId()).fields()) {
                var selected = field.selected(next.views().get(key));
                var previous = field.selected(old.views().get(key));
                if (selected != previous && (selected == null || previous == null || selected.age() != previous.age())) {
                    replacements.put(new FreshnessDeadlines.Key(key, field), deadline(field, selected, 0, monotonic));
                }
            }
        }
        return replacements;
    }

    void install(StateStore storage, StateImage old, StateImage next, ReceiptClock.Sample sample) {
        boolean rollback = observations.detected(sample);
        if (rollback) next = ClockRollback.markRetainedReceipts(old, next);
        storage.install(next);
        observations.committed(sample, rollback);
    }

    void installed(Map<FreshnessDeadlines.Key, Long> replacements) {
        replacements.forEach(deadlines::replace);
        arm();
    }

    private Long deadline(BoundView.Field field, SelectedContribution selected, long elapsed, long monotonic) {
        var age = selected == null ? null : selected.age();
        Long remaining = field.freshness().remaining(age, elapsed);
        return remaining == null ? null : Math.addExact(monotonic, remaining);
    }

    void reconcile(StateStore storage) {
        var first = deadlines.next();
        if (first == null || first > clock.monotonicMillis()) return;
        var due = deadlines.due(clock.monotonicMillis());
        var old = storage.current();
        var rows = new HashMap<>(old.views());
        long version = Math.incrementExact(old.version());
        for (var key : due) {
            var row = rows.get(key.entity());
            var field = key.field();
            var winner = field.selected(row);
            rows.put(key.entity(), row.replaceCandidate(field.name(), winner.provenance().sourceId(),
                    winner.withAge(winner.age().stale()), version));
        }
        var sample = clock.sample();
        install(storage, old, new StateImage(version, old.streams(), Map.copyOf(rows), highWater(old, sample.wall())), sample);
        due.forEach(key -> deadlines.replace(key, null));
        arm();
    }

    void arm() {
        Long next = deadlines.next();
        if (Objects.equals(armed, next) && alarm != null && !alarm.isDone()) return;
        if (alarm != null) alarm.cancel(false);
        armed = next;
        alarm = next == null ? null : timer.schedule(wake, Math.max(0, next - clock.monotonicMillis()), TimeUnit.MILLISECONDS);
    }

    public void close() { timer.shutdownNow(); }
}
