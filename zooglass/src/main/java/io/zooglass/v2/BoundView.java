package io.zooglass.v2;

import io.zooglass.strategy.late.LateDeliveryStrategy;
import io.zooglass.strategy.late.LateStrategySelection;

import io.zooglass.ViewConfiguration;
import io.zooglass.strategy.identity.EntityResolution;
import io.zooglass.strategy.identity.EntityResolutionStrategy;
import io.zooglass.strategy.identity.EntityStrategySelection;
import io.zooglass.strategy.update.FieldStrategySelection;
import io.zooglass.strategy.update.FieldUpdateStrategy;
import io.zooglass.strategy.contribution.ContributionSelectionStrategy;
import io.zooglass.strategy.contribution.ContributionStrategySelection;
import io.zooglass.strategy.contribution.SelectedContribution;
import tools.jackson.databind.JsonNode;

import java.util.HashMap;
import java.util.ArrayList;
import java.util.stream.Collectors;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Immutable field bindings reuse the update modules; state belongs to the coordinator. */
final class BoundView {
    private final String id;
    private final List<Field> fields;
    private final Map<String, EntityResolutionStrategy> resolvers;

    BoundView(V2Configuration.View definition) {
        id = definition.id();
        var selected = new LinkedHashMap<String, EntityResolutionStrategy>();
        definition.entities().forEach((source, config) -> selected.put(source,
                EntityStrategySelection.select(config.mode(), config.keys())));
        resolvers = Map.copyOf(selected);
        fields = definition.fields().entrySet().stream().map(entry -> {
            var config = entry.getValue();
            var ordering = config.mode().equals("arrival") ? null
                    : new ViewConfiguration.Ordering(config.mode(), "publicationSequence");
            var conflict = config.conflict();
            return new Field(entry.getKey(), config.allInputs(),
                    config.mode().equals("historyBySequence"), FieldStrategySelection.select(ordering),
                    ContributionStrategySelection.select(conflict == null ? "independentFields" : conflict.mode(),
                            conflict == null ? null : conflict.sources(), config.allInputs().stream()
                                    .map(V2Configuration.Input::sourceId).collect(Collectors.toSet())),
                    LateStrategySelection.select(config.late().mode()));
        }).toList();
    }

    String id() {
        return id;
    }

    boolean matches(Publication publication) {
        return fields.stream().anyMatch(field -> field.matches(publication));
    }

    EntityResolution resolve(Publication publication) { return resolve(publication.stream()); }

    EntityResolution resolve(Publication.StreamKey stream) {
        var resolver = resolvers.get(stream.sourceId());
        return resolver == null ? null : resolver.resolve(stream.sourceEntityId());
    }

    Evaluation evaluate(Publication publication, JsonNode contribution,
            StateImage.StoredView current, int historyLimit, long version, Long watermark) {
        var candidates = new HashMap<String, Map<String, SelectedContribution>>(
                current == null ? Map.of() : current.candidates());
        var data = new HashMap<String, JsonNode>(current == null ? Map.of() : current.data());
        var provenance = new HashMap<String, Provenance>(current == null ? Map.of() : current.provenance());
        var changedFields = new ArrayList<String>();
        var outcomes = new ArrayList<TargetOutcome.FieldOutcome>();
        boolean updated = false;

        for (Field field : fields) {
            if (!field.matches(publication)) {
                continue;
            }
            if (!field.late.accepts(publication.publicationSequence(), watermark)) {
                outcomes.add(new TargetOutcome.FieldOutcome(field.name, "rejected", "behindWatermark", false));
                continue;
            }
            int outcomeIndex = outcomes.size();
            outcomes.add(new TargetOutcome.FieldOutcome(field.name, "accepted", null, false));
            var sources = new HashMap<>(candidates.getOrDefault(field.name, Map.of()));
            var previous = sources.get(publication.sourceId());
            var update = field.strategy.evaluate(previous == null ? null : previous.value(), contribution);
            if (!update.changed()) {
                continue;
            }
            if (field.history && update.replacement().size() > historyLimit) {
                throw new CapacityExceeded();
            }
            sources.put(publication.sourceId(), new SelectedContribution(update.replacement(),
                    new Provenance(publication.sourceId(), publication.epoch(), publication.sourceEntityId())));
            candidates.put(field.name, Map.copyOf(sources));
            updated = true;
            var selected = field.selection.select(sources);
            if (!selected.value().equals(data.get(field.name))
                    || !selected.provenance().equals(provenance.get(field.name))) {
                data.put(field.name, selected.value());
                provenance.put(field.name, selected.provenance());
                changedFields.add(field.name);
                outcomes.set(outcomeIndex, new TargetOutcome.FieldOutcome(field.name, "accepted", null, true));
            }
        }
        var stored = updated ? new StateImage.StoredView(
                changedFields.isEmpty() ? current.version() : version, data, provenance, candidates) : current;
        return new Evaluation(stored, List.copyOf(changedFields), List.copyOf(outcomes));
    }

    record Evaluation(StateImage.StoredView stored, List<String> changedFields, List<TargetOutcome.FieldOutcome> fields) {}

    private record Field(String name, List<V2Configuration.Input> inputs, boolean history,
            FieldUpdateStrategy strategy, ContributionSelectionStrategy selection, LateDeliveryStrategy late) {
        boolean matches(Publication publication) {
            return inputs.stream().anyMatch(input -> input.sourceId().equals(publication.sourceId())
                    && input.type().equals(publication.type()));
        }
    }

    static final class CapacityExceeded extends RuntimeException {}
}
