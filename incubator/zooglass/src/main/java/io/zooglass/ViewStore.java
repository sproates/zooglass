package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

@Component
public class ViewStore {

    private final Map<EventKey, List<FieldTarget>> targetsByEvent = new HashMap<>();
    private final Map<String, Map<String, Map<String, JsonNode>>> dataByView = new HashMap<>();

    @Autowired
    public ViewStore(
            ObjectMapper objectMapper,
            ResourceLoader resourceLoader,
            @Value("${zooglass.views.config:classpath:views.json}") String configLocation) {
        this(loadConfiguration(objectMapper, resourceLoader, configLocation));
    }

    ViewStore(ViewConfiguration configuration) {
        if (configuration == null || configuration.views() == null) {
            throw new IllegalStateException("View configuration must contain a views array.");
        }

        Set<String> viewIds = new HashSet<>();
        for (ViewConfiguration.ViewDefinition view : configuration.views()) {
            if (view == null) {
                throw new IllegalStateException("View configuration contains an empty view definition.");
            }
            try {
                validate(view);
            } catch (IllegalArgumentException exception) {
                throw new IllegalStateException(exception.getMessage(), exception);
            }
            if (!viewIds.add(view.id())) {
                throw new IllegalStateException("View id is configured more than once: " + view.id());
            }
            register(view);
        }
    }

    public synchronized boolean define(ViewConfiguration.ViewDefinition view) {
        validate(view);
        if (dataByView.containsKey(view.id())) {
            return false;
        }

        register(view);
        return true;
    }

    private void register(ViewConfiguration.ViewDefinition view) {
        List<Map.Entry<EventKey, FieldTarget>> targets = new ArrayList<>();
        for (Map.Entry<String, List<ViewConfiguration.EventMatcher>> field : view.fields().entrySet()) {
            for (ViewConfiguration.EventMatcher matcher : field.getValue()) {
                targets.add(Map.entry(
                        new EventKey(matcher.sourceId(), matcher.type()),
                        new FieldTarget(view.id(), field.getKey())));
            }
        }

        dataByView.put(view.id(), new HashMap<>());
        for (Map.Entry<EventKey, FieldTarget> target : targets) {
            targetsByEvent.computeIfAbsent(target.getKey(), ignored -> new ArrayList<>()).add(target.getValue());
        }
    }

    private static void validate(ViewConfiguration.ViewDefinition view) {
        if (view == null) {
            throw new IllegalArgumentException("View definition must be a JSON object.");
        }
        validateName(view.id(), "view id");
        if (view.fields() == null || view.fields().isEmpty()) {
            throw new IllegalArgumentException("View " + view.id() + " must define at least one field.");
        }

        for (Map.Entry<String, List<ViewConfiguration.EventMatcher>> field : view.fields().entrySet()) {
            validateName(field.getKey(), "field name in view " + view.id());
            if (field.getValue() == null || field.getValue().isEmpty()) {
                throw new IllegalArgumentException("View field " + field.getKey() + " must define at least one event matcher.");
            }
            for (ViewConfiguration.EventMatcher matcher : field.getValue()) {
                if (matcher == null) {
                    throw new IllegalArgumentException("View field " + field.getKey() + " has an empty event matcher.");
                }
                validateName(matcher.sourceId(), "sourceId for " + view.id() + "." + field.getKey());
                validateName(matcher.type(), "type for " + view.id() + "." + field.getKey());
            }
        }
    }

    private static ViewConfiguration loadConfiguration(
            ObjectMapper objectMapper,
            ResourceLoader resourceLoader,
            String configLocation) {
        Resource resource = resourceLoader.getResource(configLocation);
        ViewConfiguration configuration;
        try (var input = resource.getInputStream()) {
            configuration = objectMapper.readValue(input, ViewConfiguration.class);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not load view configuration from " + configLocation, exception);
        }

        return configuration;
    }

    private static void validateName(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("View configuration requires a non-empty " + label + ".");
        }
    }

    public synchronized void apply(String sourceId, String type, String entityId, JsonNode payload) {
        List<FieldTarget> targets = targetsByEvent.getOrDefault(new EventKey(sourceId, type), List.of());
        for (FieldTarget target : targets) {
            Map<String, JsonNode> viewData = dataByView.get(target.viewId())
                    .computeIfAbsent(entityId, ignored -> new LinkedHashMap<>());
            viewData.put(target.fieldName(), payload.deepCopy());
        }
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

    private record FieldTarget(String viewId, String fieldName) {
    }
}
