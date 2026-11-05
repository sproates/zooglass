package io.zooglass.runtime;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Resolve and stage every named field before the coordinator commits any floor. */
final class FactRetirementTransitions {

    private final RuntimeConfiguration configuration;
    private final Map<String, BoundView> bindings;

    FactRetirementTransitions(RuntimeConfiguration configuration, Map<String, BoundView> bindings) {
        this.configuration = configuration;
        this.bindings = bindings;
    }

    Result stage(StateImage state, FactRetirement control, long version) {
        var view =
                configuration.views().stream()
                        .filter(v -> v.id().equals(control.viewId()))
                        .findFirst()
                        .orElseThrow(() -> new FactRejected("unknownView"));
        String source = null;
        for (String name : control.fields()) {
            var field = view.fields().get(name);
            if (field == null || field.facts() == null) {
                throw new FactRejected("unknownFactField");
            }
            if (source != null && !source.equals(field.sourceId())) {
                throw new FactRejected("incompatibleFactFields");
            }
            source = field.sourceId();
        }
        var resolver = view.entities().get(source);
        String original = control.entityId();
        if (resolver.keys() != null) {
            original =
                    resolver.keys().entrySet().stream()
                            .filter(e -> e.getValue().equals(control.entityId()))
                            .map(Map.Entry::getKey)
                            .findFirst()
                            .orElseThrow(() -> new FactRejected("unknownEntityMapping"));
        }
        String sourceId = source;
        String epoch =
                configuration.sources().stream()
                        .filter(s -> s.id().equals(sourceId))
                        .findFirst()
                        .orElseThrow()
                        .epoch();
        var streamKey = new Publication.StreamKey(source, epoch, original);
        var streams = new HashMap<>(state.streams());
        var key = new StateImage.ViewEntity(view.id(), control.entityId());
        var current = state.views().get(key);
        var floors = new HashMap<String, Long>();
        boolean changed = false;
        for (String field : control.fields()) {
            var facts = current == null ? null : current.facts().get(field);
            long floor =
                    facts == null
                            ? view.fields().get(field).facts().minimumBirthSequence()
                            : facts.floor();
            if (control.minimumBirthSequence() < floor) {
                throw new FactRejected("backwardsFactFloor");
            }
            // Equal to the configured floor is already guaranteed without allocating state.
            changed |= control.minimumBirthSequence() > floor;
            floors.put(field, control.minimumBirthSequence());
        }
        if (!changed) {
            return new Result(state.streams(), null, Map.copyOf(floors));
        }

        if (!streams.containsKey(streamKey)) {
            if (streams.size() >= configuration.maxStreams()) {
                throw new FactRejected("streamLimit");
            }
            // An allocated empty stream records bounded ownership, without a progress promise.
            var settings =
                    configuration.sources().stream()
                            .filter(s -> s.id().equals(sourceId))
                            .findFirst()
                            .orElseThrow()
                            .progress();
            var progress =
                    io.zooglass.strategy.progress.ProgressStrategySelection.select(
                                    settings.mode(),
                                    settings.startSequence(),
                                    settings.maxReceivedRanges(),
                                    settings.maxMissingRanges())
                            .initial();
            streams.put(streamKey, new StateImage.StreamState(1, Map.of(), progress, true));
        }

        var bound = bindings.get(view.id());
        var evaluated =
                bound.retire(
                        current, original, epoch, control.fields(), control.minimumBirthSequence());
        var next = evaluated.stored();
        if (next.pending() && (current == null || !current.pending())) {
            long pending =
                    state.views().entrySet().stream()
                            .filter(
                                    e ->
                                            e.getKey().viewId().equals(view.id())
                                                    && e.getValue().pending())
                            .count();
            if (bound.exposure().atCapacity(pending)) {
                throw new FactRejected("pendingViewLimit");
            }
        }
        next =
                new StateImage.StoredView(
                        version, next.data(), next.provenance(), next.candidates(), next.facts());
        var rows = new HashMap<>(state.views());
        rows.put(key, next);
        var staged =
                new ViewTransitions.Result(
                        Map.copyOf(rows), List.of(view.id()), List.of(), List.of(key));
        return new Result(Map.copyOf(streams), staged, Map.copyOf(floors));
    }

    record Result(
            Map<Publication.StreamKey, StateImage.StreamState> streams,
            ViewTransitions.Result staged,
            Map<String, Long> floors) {}
}
