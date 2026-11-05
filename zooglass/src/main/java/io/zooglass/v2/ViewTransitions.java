package io.zooglass.v2;

import tools.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Stages source-driven value and metadata changes together, without installing retained state. */
final class ViewTransitions {
    private final List<Binding> bindings;
    private final Map<String, BoundView> byId;

    ViewTransitions(V2Configuration configuration) {
        bindings = configuration.views().stream().map(definition -> {
            var view = new BoundView(definition);
            var status = new ViewStatus(definition, configuration.sources(), view);
            return new Binding(definition.id(), view, status);
        }).toList();
        byId = bindings.stream().collect(java.util.stream.Collectors.toUnmodifiableMap(Binding::id, Binding::view));
    }

    Map<String, BoundView> byId() {
        return byId;
    }

    ViewStatus.Status status(String view, String entity, StateImage.StoredView stored,
            Map<Publication.StreamKey, StateImage.StreamState> streams) {
        return bindings.stream().filter(binding -> binding.id.equals(view)).findFirst()
                .map(binding -> binding.status.project(entity, stored, streams)).orElse(null);
    }

    Result stage(StateImage state, Map<Publication.StreamKey, StateImage.StreamState> streams,
            Publication.StreamKey source, Publication event, JsonNode contribution, int historyLimit, long version, long wallMillis) {
        var candidates = new HashMap<>(state.views());
        var touched = new ArrayList<StateImage.ViewEntity>();
        var changed = new ArrayList<String>();
        var targets = new ArrayList<TargetOutcome>();
        var previousStream = state.streams().get(source);
        Long watermark = previousStream == null || previousStream.progress() == null
                ? null : previousStream.progress().watermarkThrough();
        for (var binding : bindings) {
            boolean matched = event != null && binding.view.matches(event);
            var resolution = binding.view.resolve(source);
            if (resolution == null) continue;
            if (!resolution.resolved()) {
                if (matched) targets.add(new TargetOutcome(binding.id, null, "rejected", "unknownEntityMapping", List.of(), List.of()));
                continue;
            }
            var key = new StateImage.ViewEntity(binding.id, resolution.entityId());
            var current = state.views().get(key);
            var next = current;
            if (matched) {
                var evaluated = binding.view.evaluate(event, contribution, current, historyLimit, watermark, wallMillis);
                next = evaluated.stored();
                if (next != null && next.pending() && (current == null || !current.pending())) {
                    long pending = state.views().entrySet().stream()
                            .filter(entry -> entry.getKey().viewId().equals(binding.id) && entry.getValue().pending()).count();
                    if (binding.view.exposure().atCapacity(pending)) throw new PendingLimit();
                }
                boolean accepted = evaluated.fields().stream().anyMatch(field -> field.status().equals("accepted"));
                targets.add(new TargetOutcome(binding.id, resolution.entityId(), accepted ? "accepted" : "rejected",
                        accepted ? null : evaluated.fields().getFirst().reason(), evaluated.changedFields(), evaluated.fields()));
            }
            boolean visible = !binding.status.project(key.entityId(), current, state.streams())
                    .equals(binding.status.project(key.entityId(), next, streams))
                    || next != null && (current == null || !next.data().equals(current.data())
                        || !next.provenance().equals(current.provenance()));
            if (visible) {
                changed.add(binding.id);
                next = new StateImage.StoredView(version, next == null ? Map.of() : next.data(),
                        next == null ? Map.of() : next.provenance(), next == null ? Map.of() : next.candidates(),
                        next == null ? Map.of() : next.facts());
            }
            if (next != current) {
                candidates.put(key, next);
                touched.add(key);
            }
        }
        return new Result(Map.copyOf(candidates), List.copyOf(changed), List.copyOf(targets), List.copyOf(touched));
    }

    static final class PendingLimit extends RuntimeException {}

    private record Binding(String id, BoundView view, ViewStatus status) {}
    record Result(Map<StateImage.ViewEntity, StateImage.StoredView> views, List<String> changedViews,
            List<TargetOutcome> targets, List<StateImage.ViewEntity> touched) {}
}
