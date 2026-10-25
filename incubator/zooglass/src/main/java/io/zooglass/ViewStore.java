package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

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
        for (Map.Entry<String, List<ViewConfiguration.EventMatcher>> field : view.fields().entrySet()) {
            ViewConfiguration.Ordering ordering = view.ordering() == null
                    ? null
                    : view.ordering().get(field.getKey());
            for (ViewConfiguration.EventMatcher matcher : field.getValue()) {
                targets.add(Map.entry(
                        new EventKey(matcher.sourceId(), matcher.type()),
                        new FieldTarget(view.id(), field.getKey(), ordering)));
            }
        }

        dataByView.put(view.id(), new HashMap<>());
        for (Map.Entry<EventKey, FieldTarget> target : targets) {
            targetsByEvent.computeIfAbsent(target.getKey(), ignored -> new ArrayList<>()).add(target.getValue());
        }
    }

    public synchronized List<ViewSnapshot> apply(String sourceId, String type, String entityId, JsonNode payload) {
        List<FieldTarget> targets = targetsByEvent.getOrDefault(new EventKey(sourceId, type), List.of());
        Set<String> changedViews = new LinkedHashSet<>();
        for (FieldTarget target : targets) {
            Map<String, Map<String, JsonNode>> entities = dataByView.get(target.viewId());
            Map<String, JsonNode> viewData = entities.get(entityId);
            boolean newEntity = viewData == null;
            if (newEntity) {
                viewData = new LinkedHashMap<>();
            }
            boolean changed = FieldUpdates.apply(viewData, target.fieldName(), target.ordering(), payload);
            if (changed) {
                if (newEntity) {
                    entities.put(entityId, viewData);
                }
                changedViews.add(target.viewId());
            }
        }
        return changedViews.stream()
                .map(viewId -> get(viewId, entityId).orElseThrow())
                .toList();
    }

    public synchronized boolean containsView(String viewId) {
        return dataByView.containsKey(viewId);
    }

    public synchronized Optional<ViewSnapshot> get(String viewId, String entityId) {
        Map<String, JsonNode> data = dataByView.getOrDefault(viewId, Map.of()).get(entityId);
        if (data == null) {
            return Optional.empty();
        }

        Map<String, JsonNode> copy = new LinkedHashMap<>();
        data.forEach((field, value) -> copy.put(field, value.deepCopy()));
        return Optional.of(new ViewSnapshot(viewId, entityId, copy));
    }

    private record EventKey(String sourceId, String type) {
    }

    private record FieldTarget(String viewId, String fieldName, ViewConfiguration.Ordering ordering) {
    }
}
