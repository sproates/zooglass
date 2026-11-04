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
    private final Map<String, InputBinding> inputs;

    ViewStatus(V2Configuration.View definition, List<V2Configuration.Source> sources) {
        this.definition = definition;
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
        var data = view == null ? Map.of() : view.data();
        var missing = definition.fields().keySet().stream().filter(field -> !data.containsKey(field)).sorted().toList();
        var fields = new TreeMap<String, FieldStatus>();
        definition.fields().forEach((name, field) -> fields.put(name, new FieldStatus(
                data.containsKey(name) ? "unspecified" : "absent", null,
                field.allInputs().stream().map(V2Configuration.Input::sourceId).sorted().toList())));
        var statuses = new TreeMap<String, InputStatus>();
        inputs.forEach((source, binding) -> {
            String original = binding.inverse == null ? entity : binding.inverse.get(entity);
            var stream = original == null ? null : streams.get(new Publication.StreamKey(source, binding.source.epoch(), original));
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
        return new Status(missing.isEmpty() ? "ready" : "partial", missing, List.of(), fields, statuses);
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
    public record FieldStatus(String freshness, Long receivedAtMillis, List<String> inputs) {}
    public record InputStatus(String state, String mode, String epoch, String sourceEntityId, Long startSequence,
            Long observedThrough, Long watermarkThrough, Long completeThrough, String completeness,
            Long admissionFloor, boolean sourceContractViolated, List<ProgressState.Missing> missingRanges) {}
}
