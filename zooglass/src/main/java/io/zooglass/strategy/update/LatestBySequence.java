package io.zooglass.strategy.update;

import tools.jackson.databind.JsonNode;

final class LatestBySequence implements FieldUpdateStrategy {
    private final String sequenceField;

    LatestBySequence(String sequenceField) {
        this.sequenceField = sequenceField;
    }

    @Override
    public FieldUpdate evaluate(JsonNode current, JsonNode incoming) {
        JsonNode nextSequence = SequenceValues.read(incoming, sequenceField);
        if (nextSequence == null) {
            return FieldUpdate.unchanged();
        }

        JsonNode currentSequence = SequenceValues.read(current, sequenceField);
        if (currentSequence != null && SequenceValues.compare(nextSequence, currentSequence) <= 0) {
            return FieldUpdate.unchanged();
        }

        return FieldUpdate.replaced(incoming.deepCopy());
    }
}
