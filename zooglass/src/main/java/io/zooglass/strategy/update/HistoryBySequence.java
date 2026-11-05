package io.zooglass.strategy.update;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

final class HistoryBySequence implements FieldUpdateStrategy {

    private final String sequenceField;

    HistoryBySequence(String sequenceField) {
        this.sequenceField = sequenceField;
    }

    @Override
    public FieldUpdate evaluate(JsonNode current, JsonNode incoming) {
        JsonNode nextSequence = SequenceValues.read(incoming, sequenceField);
        if (nextSequence == null) {
            return FieldUpdate.unchanged();
        }

        List<JsonNode> events = new ArrayList<>();
        if (current != null && current.isArray()) {
            current.forEach(event -> events.add(event.deepCopy()));
        }
        if (events.stream()
                .anyMatch(
                        event ->
                                SequenceValues.compare(
                                                SequenceValues.read(event, sequenceField),
                                                nextSequence)
                                        == 0)) {
            return FieldUpdate.unchanged();
        }

        events.add(incoming.deepCopy());
        events.sort(
                Comparator.comparing(
                        event -> SequenceValues.read(event, sequenceField),
                        SequenceValues::compare));
        ArrayNode history = JsonNodeFactory.instance.arrayNode();
        events.forEach(history::add);
        return FieldUpdate.replaced(history);
    }
}
