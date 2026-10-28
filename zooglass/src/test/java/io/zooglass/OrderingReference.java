package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Rebuilds expected views from the received prefix, without using ViewStore state or helpers. */
final class OrderingReference {
    private static final JsonMapper JSON = JsonMapper.builder().build();

    record Event(String source, String type, String entity, JsonNode payload) {
        @Override
        public String toString() {
            return source + "/" + type + "/" + entity + ":" + payload;
        }
    }

    static Map<String, JsonNode> expected(List<Event> received, String entity, boolean history) {
        Map<String, JsonNode> fields = new LinkedHashMap<>();
        addField(fields, "primary", received, entity, List.of("primary-feed"), history);
        addField(fields, "backup", received, entity, List.of("backup-feed"), history);
        addField(fields, "shared", received, entity, List.of("primary-feed", "backup-feed"), history);
        return fields;
    }

    private static void addField(Map<String, JsonNode> fields, String field,
            List<Event> received, String entity, List<String> sources, boolean history) {
        // Numeric keys collapse equal values such as 1 and 1.0. Arrival order decides ties.
        TreeMap<BigDecimal, JsonNode> firstBySequence = new TreeMap<>();
        for (Event event : received) {
            if (!event.entity().equals(entity) || !sources.contains(event.source())
                    || !event.type().equals("position")) {
                continue;
            }
            JsonNode sequence = event.payload().get("sequence");
            if (sequence != null && sequence.isNumber()) {
                firstBySequence.putIfAbsent(new BigDecimal(sequence.toString()), event.payload());
            }
        }
        if (!firstBySequence.isEmpty()) {
            fields.put(field, history
                    ? JSON.valueToTree(List.copyOf(firstBySequence.values()))
                    : firstBySequence.lastEntry().getValue());
        }
    }

    static ViewConfiguration configuration() {
        var primary = new ViewConfiguration.EventMatcher("primary-feed", "position");
        var backup = new ViewConfiguration.EventMatcher("backup-feed", "position");
        Map<String, List<ViewConfiguration.EventMatcher>> fields = Map.of(
                "primary", List.of(primary), "backup", List.of(backup),
                "shared", List.of(primary, backup));
        return new ViewConfiguration(List.of(
                definition("latest", fields, "latestBySequence"),
                definition("history", fields, "historyBySequence")));
    }

    private static ViewConfiguration.ViewDefinition definition(String id,
            Map<String, List<ViewConfiguration.EventMatcher>> fields, String mode) {
        var ordering = new ViewConfiguration.Ordering(mode, "sequence");
        return new ViewConfiguration.ViewDefinition(id, fields,
                Map.of("primary", ordering, "backup", ordering, "shared", ordering));
    }

    static Event event(String source, String type, String entity, String sequence, String label) {
        var payload = JSON.createObjectNode().put("label", label);
        if (sequence != null) {
            payload.set("sequence", JSON.readTree(sequence));
        }
        return new Event(source, type, entity, payload);
    }

    private OrderingReference() {
    }
}
