package io.zooglass.strategy.update;

import tools.jackson.databind.JsonNode;

/** Numeric sequences retain decimal precision, including integers beyond double range. */
final class SequenceValues {

    private SequenceValues() {}

    static JsonNode read(JsonNode payload, String field) {
        JsonNode value = payload == null ? null : payload.get(field);
        return value != null && value.isNumber() ? value : null;
    }

    static int compare(JsonNode left, JsonNode right) {
        return left.decimalValue().compareTo(right.decimalValue());
    }
}
