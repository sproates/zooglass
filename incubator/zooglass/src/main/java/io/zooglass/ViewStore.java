package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
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

        if (view.ordering() != null) {
            for (Map.Entry<String, ViewConfiguration.Ordering> entry : view.ordering().entrySet()) {
                if (!view.fields().containsKey(entry.getKey())) {
                    throw new IllegalArgumentException("Ordering is configured for unknown view field "
                            + entry.getKey() + " in view " + view.id() + ".");
                }
                ViewConfiguration.Ordering ordering = entry.getValue();
                if (ordering == null || !("latestBySequence".equals(ordering.mode())
                        || "historyBySequence".equals(ordering.mode()))) {
                    throw new IllegalArgumentException("View " + view.id() + " has an unsupported ordering mode.");
                }
                validateName(ordering.sequenceField(), "sequenceField for " + view.id() + "." + entry.getKey());
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

    public synchronized List<ViewSnapshot> apply(String sourceId, String type, String entityId, JsonNode payload) {
        List<FieldTarget> targets = targetsByEvent.getOrDefault(new EventKey(sourceId, type), List.of());
        Set<String> changedViews = new LinkedHashSet<>();
        for (FieldTarget target : targets) {
            Map<String, JsonNode> viewData = dataByView.get(target.viewId())
                    .computeIfAbsent(entityId, ignored -> new LinkedHashMap<>());
            boolean changed = switch (target.ordering() == null ? "arrival" : target.ordering().mode()) {
                case "latestBySequence" -> applyLatestBySequence(viewData, target, payload);
                case "historyBySequence" -> applyHistoryBySequence(viewData, target, payload);
                default -> {
                    viewData.put(target.fieldName(), payload.deepCopy());
                    yield true;
                }
            };
            if (changed) {
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

    private static boolean applyLatestBySequence(
            Map<String, JsonNode> viewData,
            FieldTarget target,
            JsonNode payload) {
        JsonNode sequence = sequence(payload, target.ordering().sequenceField());
        if (sequence == null) {
            return false;
        }

        JsonNode current = viewData.get(target.fieldName());
        if (current != null && sequence(current, target.ordering().sequenceField()) != null
                && compareSequences(sequence, sequence(current, target.ordering().sequenceField())) <= 0) {
            return false;
        }

        viewData.put(target.fieldName(), payload.deepCopy());
        return true;
    }

    private static boolean applyHistoryBySequence(
            Map<String, JsonNode> viewData,
            FieldTarget target,
            JsonNode payload) {
        JsonNode newSequence = sequence(payload, target.ordering().sequenceField());
        if (newSequence == null) {
            return false;
        }

        List<JsonNode> events = new ArrayList<>();
        JsonNode current = viewData.get(target.fieldName());
        if (current != null && current.isArray()) {
            current.forEach(event -> events.add(event.deepCopy()));
        }
        if (events.stream().anyMatch(event -> compareSequences(
                sequence(event, target.ordering().sequenceField()), newSequence) == 0)) {
            return false;
        }
        events.add(payload.deepCopy());
        events.sort(Comparator.comparing(
                event -> sequence(event, target.ordering().sequenceField()),
                ViewStore::compareSequences));
        ArrayNode history = JsonNodeFactory.instance.arrayNode();
        events.forEach(history::add);
        viewData.put(target.fieldName(), history);
        return true;
    }

    private static JsonNode sequence(JsonNode payload, String fieldName) {
        JsonNode sequence = payload.get(fieldName);
        return sequence != null && sequence.isNumber() ? sequence : null;
    }

    private static int compareSequences(JsonNode left, JsonNode right) {
        return left.decimalValue().compareTo(right.decimalValue());
    }

    private record FieldTarget(String viewId, String fieldName, ViewConfiguration.Ordering ordering) {
    }
}
