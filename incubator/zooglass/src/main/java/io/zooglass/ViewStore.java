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
            validateName(view == null ? null : view.id(), "view id");
            if (!viewIds.add(view.id())) {
                throw new IllegalStateException("View id is configured more than once: " + view.id());
            }
            if (view.fields() == null || view.fields().isEmpty()) {
                throw new IllegalStateException("View " + view.id() + " must define at least one field.");
            }

            dataByView.put(view.id(), new HashMap<>());
            for (Map.Entry<String, ViewConfiguration.EventMatcher> field : view.fields().entrySet()) {
                validateName(field.getKey(), "field name in view " + view.id());
                ViewConfiguration.EventMatcher matcher = field.getValue();
                if (matcher == null) {
                    throw new IllegalStateException("View field " + field.getKey() + " must define an event matcher.");
                }
                validateName(matcher.sourceId(), "sourceId for " + view.id() + "." + field.getKey());
                validateName(matcher.type(), "type for " + view.id() + "." + field.getKey());

                EventKey key = new EventKey(matcher.sourceId(), matcher.type());
                targetsByEvent.computeIfAbsent(key, ignored -> new ArrayList<>())
                        .add(new FieldTarget(view.id(), field.getKey()));
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
            throw new IllegalStateException("View configuration requires a non-empty " + label + ".");
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
