package io.zooglass;

import io.zooglass.strategy.update.FieldStrategySelection;
import io.zooglass.strategy.update.FieldUpdate;
import io.zooglass.strategy.update.FieldUpdateStrategy;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** Owns registered matchers and entity state; all reads and updates use this monitor. */
@Component
public class ViewStore {

    private final Map<EventKey, List<FieldTarget>> targetsByEvent = new HashMap<>();
    private final Map<String, Map<String, Map<String, JsonNode>>> dataByView = new HashMap<>();

    @Autowired
    public ViewStore(
            ObjectMapper objectMapper,
            ResourceLoader resourceLoader,
            @Value("${zooglass.views.config:classpath:views.json}") String configLocation) {
        this(ViewDefinitions.load(objectMapper, resourceLoader, configLocation));
    }

    ViewStore(ViewConfiguration configuration) {
        ViewDefinitions.validateConfiguration(configuration);
        for (ViewConfiguration.ViewDefinition view : configuration.views()) {
            register(view);
        }
    }

    public synchronized boolean define(ViewConfiguration.ViewDefinition view) {
        ViewDefinitions.validate(view);
        if (dataByView.containsKey(view.id())) {
            return false;
        }

        register(view);
        return true;
    }

    private void register(ViewConfiguration.ViewDefinition view) {
        List<Map.Entry<EventKey, FieldTarget>> targets = new ArrayList<>();
        for (Map.Entry<String, List<ViewConfiguration.EventMatcher>> field :
                view.fields().entrySet()) {
            ViewConfiguration.Ordering ordering =
                    view.ordering() == null ? null : view.ordering().get(field.getKey());
            FieldUpdateStrategy strategy = FieldStrategySelection.select(ordering);
            for (ViewConfiguration.EventMatcher matcher : field.getValue()) {
                targets.add(
                        Map.entry(
                                new EventKey(matcher.sourceId(), matcher.type()),
                                new FieldTarget(view.id(), field.getKey(), strategy)));
            }
        }

        dataByView.put(view.id(), new HashMap<>());
        for (Map.Entry<EventKey, FieldTarget> target : targets) {
            targetsByEvent
                    .computeIfAbsent(target.getKey(), ignored -> new ArrayList<>())
                    .add(target.getValue());
        }
    }

    public synchronized List<ViewSnapshot> apply(
            String sourceId, String type, String entityId, JsonNode payload) {
        List<FieldTarget> targets =
                targetsByEvent.getOrDefault(new EventKey(sourceId, type), List.of());
        Map<String, Map<String, JsonNode>> stagedViews = new LinkedHashMap<>();
        Set<String> changedViews = new LinkedHashSet<>();
        for (FieldTarget target : targets) {
            Map<String, JsonNode> candidate =
                    stagedViews.computeIfAbsent(
                            target.viewId(),
                            viewId ->
                                    new LinkedHashMap<>(
                                            dataByView
                                                    .get(viewId)
                                                    .getOrDefault(entityId, Map.of())));
            // Strategies never mutate current values; only candidate field bindings change.
            FieldUpdate update =
                    target.strategy().evaluate(candidate.get(target.fieldName()), payload);
            if (update.changed()) {
                candidate.put(target.fieldName(), update.replacement());
                changedViews.add(target.viewId());
            }
        }

        // Prepare detached publication results before installing any state. Evaluation
        // or snapshot-copy failures therefore leave every affected view unchanged.
        List<ViewSnapshot> snapshots =
                changedViews.stream()
                        .map(viewId -> snapshot(viewId, entityId, stagedViews.get(viewId)))
                        .toList();
        for (String viewId : changedViews) {
            dataByView.get(viewId).put(entityId, stagedViews.get(viewId));
        }
        return snapshots;
    }

    public synchronized boolean containsView(String viewId) {
        return dataByView.containsKey(viewId);
    }

    public synchronized Optional<ViewSnapshot> get(String viewId, String entityId) {
        Map<String, JsonNode> data = dataByView.getOrDefault(viewId, Map.of()).get(entityId);
        if (data == null) {
            return Optional.empty();
        }

        return Optional.of(snapshot(viewId, entityId, data));
    }

    private static ViewSnapshot snapshot(
            String viewId, String entityId, Map<String, JsonNode> data) {
        Map<String, JsonNode> copy = new LinkedHashMap<>();
        data.forEach((field, value) -> copy.put(field, value.deepCopy()));
        return new ViewSnapshot(viewId, entityId, copy);
    }

    private record EventKey(String sourceId, String type) {}

    private record FieldTarget(String viewId, String fieldName, FieldUpdateStrategy strategy) {}
}
