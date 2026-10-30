package io.zooglass;

// Temporary CI selection acceptance probe.

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** Applies one field policy while the owning ViewStore holds its lock. */
final class FieldUpdates {
    private FieldUpdates() {}

    static boolean apply(Map<String, JsonNode> viewData, String fieldName,
            ViewConfiguration.Ordering ordering, JsonNode payload) {
        return switch (ordering == null ? "arrival" : ordering.mode()) {
            case "latestBySequence" -> applyLatestBySequence(viewData, fieldName, ordering, payload);
            case "historyBySequence" -> applyHistoryBySequence(viewData, fieldName, ordering, payload);
            default -> {
                viewData.put(fieldName, payload.deepCopy());
                yield true;
            }
        };
    }

    private static boolean applyLatestBySequence(
            Map<String, JsonNode> viewData,
            String fieldName,
            ViewConfiguration.Ordering ordering,
            JsonNode payload) {
        JsonNode sequence = sequence(payload, ordering.sequenceField());
        if (sequence == null) {
            return false;
        }

        JsonNode current = viewData.get(fieldName);
        if (current != null && sequence(current, ordering.sequenceField()) != null
                && compareSequences(sequence, sequence(current, ordering.sequenceField())) <= 0) {
            return false;
        }

        viewData.put(fieldName, payload.deepCopy());
        return true;
    }

    private static boolean applyHistoryBySequence(
            Map<String, JsonNode> viewData,
            String fieldName,
            ViewConfiguration.Ordering ordering,
            JsonNode payload) {
        JsonNode newSequence = sequence(payload, ordering.sequenceField());
        if (newSequence == null) {
            return false;
        }

        List<JsonNode> events = new ArrayList<>();
        JsonNode current = viewData.get(fieldName);
        if (current != null && current.isArray()) {
            current.forEach(event -> events.add(event.deepCopy()));
        }
        if (events.stream().anyMatch(event -> compareSequences(
                sequence(event, ordering.sequenceField()), newSequence) == 0)) {
            return false;
        }
        events.add(payload.deepCopy());
        events.sort(Comparator.comparing(
                event -> sequence(event, ordering.sequenceField()),
                FieldUpdates::compareSequences));
        ArrayNode history = JsonNodeFactory.instance.arrayNode();
        events.forEach(history::add);
        viewData.put(fieldName, history);
        return true;
    }

    private static JsonNode sequence(JsonNode payload, String fieldName) {
        JsonNode sequence = payload.get(fieldName);
        return sequence != null && sequence.isNumber() ? sequence : null;
    }

    private static int compareSequences(JsonNode left, JsonNode right) {
        return left.decimalValue().compareTo(right.decimalValue());
    }
}
