package io.zooglass.runtime;

import io.zooglass.strategy.contribution.ContributionSelectionStrategy;
import io.zooglass.strategy.contribution.ContributionStrategySelection;
import io.zooglass.strategy.contribution.SelectedContribution;
import io.zooglass.strategy.freshness.FreshnessStrategy;
import io.zooglass.strategy.identity.EntityResolution;
import io.zooglass.strategy.identity.EntityResolutionStrategy;
import io.zooglass.strategy.identity.EntityStrategySelection;
import io.zooglass.strategy.late.LateDeliveryStrategy;
import io.zooglass.strategy.late.LateStrategySelection;
import io.zooglass.strategy.publication.PublicationStrategy;
import io.zooglass.strategy.update.FieldStrategySelection;
import io.zooglass.strategy.update.FieldUpdateStrategy;

import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Immutable field bindings reuse the update modules; state belongs to the coordinator. */
final class BoundView {

    private final PublicationStrategy exposure;
    private final String id;
    private final List<Field> fields;
    private final Map<String, EntityResolutionStrategy> resolvers;

    BoundView(RuntimeConfiguration.View definition) {
        id = definition.id();
        exposure = definition.publication().bind(definition.fields().keySet());
        var selected = new LinkedHashMap<String, EntityResolutionStrategy>();
        definition
                .entities()
                .forEach(
                        (source, config) ->
                                selected.put(
                                        source,
                                        EntityStrategySelection.select(
                                                config.mode(), config.keys())));
        resolvers = Map.copyOf(selected);
        fields =
                definition.fields().entrySet().stream()
                        .map(
                                entry -> {
                                    var config = entry.getValue();
                                    var conflict = config.conflict();
                                    return new Field(
                                            entry.getKey(),
                                            config.allInputs(),
                                            config.mode().equals("historyBySequence"),
                                            FieldStrategySelection.select(
                                                    config.facts() == null
                                                            ? config.mode()
                                                            : "arrival",
                                                    "publicationSequence"),
                                            ContributionStrategySelection.select(
                                                    conflict == null
                                                            ? "independentFields"
                                                            : conflict.mode(),
                                                    conflict == null ? null : conflict.sources(),
                                                    config.allInputs().stream()
                                                            .map(
                                                                    RuntimeConfiguration.Input
                                                                            ::sourceId)
                                                            .collect(Collectors.toSet())),
                                            LateStrategySelection.select(config.late().mode()),
                                            config.freshness().bind(),
                                            config.facts() == null
                                                    ? null
                                                    : new BoundFactField(
                                                            config.mode(),
                                                            config.property(),
                                                            config.facts()));
                                })
                        .toList();
    }

    PublicationStrategy exposure() {
        return exposure;
    }

    String id() {
        return id;
    }

    boolean matches(Publication publication) {
        return fields.stream().anyMatch(field -> field.matches(publication));
    }

    EntityResolution resolve(Publication publication) {
        return resolve(publication.stream());
    }

    EntityResolution resolve(Publication.StreamKey stream) {
        var resolver = resolvers.get(stream.sourceId());
        return resolver == null ? null : resolver.resolve(stream.sourceEntityId());
    }

    Evaluation evaluate(
            Publication publication,
            JsonNode contribution,
            StateImage.StoredView current,
            int historyLimit,
            Long watermark,
            long wallMillis) {
        var candidates =
                new HashMap<String, Map<String, SelectedContribution>>(
                        current == null ? Map.of() : current.candidates());
        var facts = new HashMap<String, FactState>(current == null ? Map.of() : current.facts());
        var outcomes = new ArrayList<TargetOutcome.FieldOutcome>();
        boolean updated = false;

        for (Field field : fields) {
            if (!field.matches(publication)) {
                continue;
            }
            if (!field.late.accepts(publication.publicationSequence(), watermark)) {
                outcomes.add(
                        new TargetOutcome.FieldOutcome(
                                field.name, "rejected", "behindWatermark", false));
                continue;
            }
            if (field.facts != null) {
                BoundFactField.Result result;
                tools.jackson.databind.JsonNode projected = null;
                try {
                    result = field.facts.evaluate(facts.get(field.name), publication);
                    if (result.changed()) {
                        projected = field.facts.project(result.state());
                    }
                } catch (FactRejected rejection) {
                    throw rejection.at(id, resolve(publication).entityId(), field.name);
                }
                outcomes.add(
                        new TargetOutcome.FieldOutcome(
                                field.name,
                                result.rejection() == null ? "accepted" : "rejected",
                                result.rejection(),
                                false));
                if (result.changed()) {
                    facts.put(field.name, result.state());
                    candidates.put(
                            field.name,
                            Map.of(
                                    publication.sourceId(),
                                    new SelectedContribution(
                                            projected,
                                            result.state().provenance(),
                                            field.freshness.received(wallMillis))));
                    updated = true;
                }
                continue;
            }
            outcomes.add(new TargetOutcome.FieldOutcome(field.name, "accepted", null, false));
            var sources = new HashMap<>(candidates.getOrDefault(field.name, Map.of()));
            var previous = sources.get(publication.sourceId());
            var update =
                    field.strategy.evaluate(
                            previous == null ? null : previous.value(), contribution);
            if (!update.changed()) {
                continue;
            }
            if (field.history && update.replacement().size() > historyLimit) {
                throw new CapacityExceeded();
            }
            sources.put(
                    publication.sourceId(),
                    new SelectedContribution(
                            update.replacement(),
                            new Provenance(
                                    publication.sourceId(),
                                    publication.epoch(),
                                    publication.sourceEntityId()),
                            field.freshness.received(wallMillis)));
            candidates.put(field.name, Map.copyOf(sources));
            updated = true;
        }
        if (!updated) {
            return new Evaluation(current, List.of(), List.copyOf(outcomes));
        }

        return publish(current, candidates, facts, outcomes);
    }

    private Evaluation publish(
            StateImage.StoredView current,
            Map<String, Map<String, SelectedContribution>> candidates,
            Map<String, FactState> facts,
            List<TargetOutcome.FieldOutcome> outcomes) {
        var data = new HashMap<String, JsonNode>();
        var provenance = new HashMap<String, Provenance>();
        var changedFields = new ArrayList<String>();
        if (exposure.missingRequired(candidates.keySet()).isEmpty()) {
            for (var field : fields) {
                var retained = candidates.get(field.name);
                if (retained == null) {
                    continue;
                }
                var selected = field.selection.select(retained);
                data.put(field.name, selected.value());
                provenance.put(field.name, selected.provenance());
                if (current == null
                        || !selected.value().equals(current.data().get(field.name))
                        || !selected.provenance().equals(current.provenance().get(field.name))) {
                    changedFields.add(field.name);
                }
            }
        }
        outcomes.replaceAll(
                outcome ->
                        new TargetOutcome.FieldOutcome(
                                outcome.field(),
                                outcome.status(),
                                outcome.reason(),
                                changedFields.contains(outcome.field())));
        var stored =
                new StateImage.StoredView(
                        current == null ? 0 : current.version(),
                        data,
                        provenance,
                        candidates,
                        facts);
        return new Evaluation(stored, List.copyOf(changedFields), List.copyOf(outcomes));
    }

    Evaluation retire(
            StateImage.StoredView current,
            String sourceEntity,
            String epoch,
            List<String> names,
            long floor) {
        var facts = new HashMap<String, FactState>(current == null ? Map.of() : current.facts());
        var candidates =
                new HashMap<String, Map<String, SelectedContribution>>(
                        current == null ? Map.of() : current.candidates());
        for (var field : fields) {
            if (!names.contains(field.name)) {
                continue;
            }
            var input = field.inputs.getFirst();
            var previous = facts.get(field.name);
            var base =
                    previous == null
                            ? field.facts.empty(
                                    new Provenance(input.sourceId(), epoch, sourceEntity),
                                    input.type())
                            : previous;
            var next = field.facts.retire(base, floor);
            facts.put(field.name, next);
            if (next.present()) {
                var oldCandidate = field.selected(current);
                candidates.put(
                        field.name,
                        Map.of(
                                input.sourceId(),
                                new SelectedContribution(
                                        field.facts.project(next),
                                        next.provenance(),
                                        oldCandidate.age())));
            }
        }
        return publish(current, candidates, facts, new ArrayList<>());
    }

    record Evaluation(
            StateImage.StoredView stored,
            List<String> changedFields,
            List<TargetOutcome.FieldOutcome> fields) {}

    List<Field> fields() {
        return fields;
    }

    record Field(
            String name,
            List<RuntimeConfiguration.Input> inputs,
            boolean history,
            FieldUpdateStrategy strategy,
            ContributionSelectionStrategy selection,
            LateDeliveryStrategy late,
            FreshnessStrategy freshness,
            BoundFactField facts) {
        SelectedContribution selected(StateImage.StoredView row) {
            var retained = row == null ? null : row.candidates().get(name);
            return retained == null ? null : selection.select(retained);
        }

        boolean matches(Publication publication) {
            return inputs.stream()
                    .anyMatch(
                            input ->
                                    input.sourceId().equals(publication.sourceId())
                                            && input.type().equals(publication.type()));
        }
    }

    static final class CapacityExceeded extends RuntimeException {}
}
