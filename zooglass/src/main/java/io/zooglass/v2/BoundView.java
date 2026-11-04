package io.zooglass.v2;

import io.zooglass.ViewConfiguration;
import io.zooglass.strategy.identity.EntityResolution;
import io.zooglass.strategy.identity.EntityResolutionStrategy;
import io.zooglass.strategy.identity.EntityStrategySelection;
import io.zooglass.strategy.update.FieldStrategySelection;
import io.zooglass.strategy.update.FieldUpdateStrategy;
import tools.jackson.databind.JsonNode;

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
            return new Field(entry.getKey(), config.sourceId(), config.type(),
                    config.mode().equals("historyBySequence"), FieldStrategySelection.select(ordering));
        }).toList();
    }

    String id() {
        return id;
    }

    boolean matches(Publication publication) {
        return fields.stream().anyMatch(field -> field.source.equals(publication.sourceId())
                && field.type.equals(publication.type()));
    }

    EntityResolution resolve(Publication publication) {
        return resolvers.get(publication.sourceId()).resolve(publication.sourceEntityId());
    }

    Map<String, JsonNode> evaluate(Publication publication, JsonNode contribution,
            Map<String, JsonNode> current, int historyLimit) {
        Map<String, JsonNode> candidate = new LinkedHashMap<>(current);
        boolean changed = false;

        for (Field field : fields) {
            if (!field.source.equals(publication.sourceId()) || !field.type.equals(publication.type())) {
                continue;
            }
            var update = field.strategy.evaluate(candidate.get(field.name), contribution);
            if (update.changed()) {
                if (field.history && update.replacement().size() > historyLimit) {
                    throw new CapacityExceeded();
                }
                candidate.put(field.name, update.replacement());
                changed = true;
            }
        }
        return changed ? candidate : null;
    }

    private record Field(String name, String source, String type, boolean history,
            FieldUpdateStrategy strategy) {}

    static final class CapacityExceeded extends RuntimeException {}
}
