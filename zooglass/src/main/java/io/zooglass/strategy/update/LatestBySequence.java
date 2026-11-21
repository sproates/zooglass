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
            return FieldUpdate.unchanged(FieldUpdate.Reason.SEQUENCE_MISSING);
        }

        JsonNode currentSequence = SequenceValues.read(current, sequenceField);
        if (currentSequence != null) {
            int order = SequenceValues.compare(nextSequence, currentSequence);
            if (order <= 0) {
                return FieldUpdate.unchanged(
                        order == 0
                                ? FieldUpdate.Reason.LATEST_EQUAL
                                : FieldUpdate.Reason.LATEST_OLDER);
            }
        }

        return FieldUpdate.replaced(
                incoming.deepCopy(),
                currentSequence == null
                        ? FieldUpdate.Reason.LATEST_INITIAL
                        : FieldUpdate.Reason.LATEST_NEWER);
    }
}
