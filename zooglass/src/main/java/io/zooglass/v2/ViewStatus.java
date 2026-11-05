package io.zooglass.v2;

import io.zooglass.strategy.progress.ProgressState;
import io.zooglass.strategy.progress.ProgressStrategy;
import io.zooglass.strategy.progress.ProgressStrategySelection;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Pure public metadata projection; neither queries nor status construction allocate retained entities. */
public final class ViewStatus {
    private final V2Configuration.View definition;
    private final BoundView bound;
    private final Map<String, InputBinding> inputs;

    ViewStatus(V2Configuration.View definition, List<V2Configuration.Source> sources, BoundView bound) {
        this.definition = definition;
        this.bound = bound;
        var bindings = new HashMap<String, InputBinding>();
        for (var source : sources) {
            var resolver = definition.entities().get(source.id());
            if (resolver == null) continue;
            Map<String, String> inverse = null;
            if (resolver.keys() != null) {
                inverse = new HashMap<>();
                for (var entry : resolver.keys().entrySet()) inverse.put(entry.getValue(), entry.getKey());
                inverse = Map.copyOf(inverse);
            }
            var settings = source.progress();
            bindings.put(source.id(), new InputBinding(source, inverse, ProgressStrategySelection.select(
                    settings.mode(), settings.startSequence(), settings.maxReceivedRanges(), settings.maxMissingRanges())));
        }
        inputs = Map.copyOf(bindings);
    }

    Status project(String entity, StateImage.StoredView view, Map<Publication.StreamKey, StateImage.StreamState> streams) {
        var present = view == null ? java.util.Set.<String>of() : view.candidates().keySet();
        var required = bound.exposure().missingRequired(present);
        var missing = definition.fields().keySet().stream().filter(field -> !present.contains(field)).sorted().toList();
        var fields = new TreeMap<String, FieldStatus>();
        for (var field : bound.fields()) {
            var selected = field.selected(view);
            var age = selected == null ? null : selected.age();
            String freshness = selected == null ? "absent" : age == null ? "unspecified" : age.classification();
            fields.put(field.name(), new FieldStatus(freshness, age == null ? null : age.receivedAtMillis(),
                    field.inputs().stream().map(V2Configuration.Input::sourceId).sorted().toList(),
                    factStatus(field, view)));
        }
        var statuses = new TreeMap<String, InputStatus>();
        inputs.forEach((source, binding) -> {
            String original = binding.inverse == null ? entity : binding.inverse.get(entity);
            var stream = original == null ? null : streams.get(new Publication.StreamKey(source, binding.source.epoch(), original));
            // A retirement can reserve capacity before the source has reported anything.
            if (stream != null && stream.reservationOnly()) stream = null;
            var progress = stream == null ? null : stream.progress();
            String completeness = "unknown";
            Long completeThrough = null;
            if (progress != null) {
                if (progress.sourceContractViolated()) completeness = "violated";
                else if (progress.watermarkThrough() != null) {
                    boolean complete = progress.receivedThrough() >= progress.watermarkThrough();
                    completeness = complete ? "completeThrough" : "incomplete";
                    if (complete) completeThrough = progress.watermarkThrough();
                }
            }
            statuses.put(source, new InputStatus(original == null ? "unmapped" : stream == null ? "notObserved" : "observed",
                    binding.source.progress().mode(), binding.source.epoch(), original,
                    binding.source.progress().startSequence(), progress == null ? null : progress.observedThrough(),
                    progress == null ? null : progress.watermarkThrough(), completeThrough, completeness,
                    stream == null ? null : stream.floor(), progress != null && progress.sourceContractViolated(),
                    progress == null ? List.of() : binding.strategy.missing(progress, stream.floor())));
        });
        String publication = required.isEmpty() ? (missing.isEmpty() ? "ready" : "partial") : "waiting";
        return new Status(publication, missing, required, fields, statuses);
    }

    private FactsStatus factStatus(BoundView.Field field, StateImage.StoredView view) {
        if (field.facts() == null) return null;
        var state = view == null ? null : view.facts().get(field.name());
        long floor = state == null ? definition.fields().get(field.name()).facts().minimumBirthSequence() : state.floor();
        return new FactsStatus(floor, state == null ? 0 : state.records().size(), state == null ? 0 :
                state.records().values().stream().filter(io.zooglass.strategy.fact.FactRecord::active).count());
    }

    private record InputBinding(V2Configuration.Source source, Map<String, String> inverse, ProgressStrategy strategy) {}

    public record Status(String publication, List<String> missingFields, List<String> missingRequiredFields,
            Map<String, FieldStatus> fields, Map<String, InputStatus> inputs) {
        public Status {
            missingFields = List.copyOf(missingFields);
            missingRequiredFields = List.copyOf(missingRequiredFields);
            fields = Map.copyOf(fields);
            inputs = Map.copyOf(inputs);
        }
    }
    public record FactsStatus(long minimumBirthSequence, long retainedCount, long activeCount) {}
    public record FieldStatus(String freshness, Long receivedAtMillis, List<String> inputs,
            @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            FactsStatus facts) {}
    public record InputStatus(String state, String mode, String epoch, String sourceEntityId, Long startSequence,
            Long observedThrough, Long watermarkThrough, Long completeThrough, String completeness,
            Long admissionFloor, boolean sourceContractViolated, List<ProgressState.Missing> missingRanges) {}
}
