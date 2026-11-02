package io.zooglass.strategy.update;

import tools.jackson.databind.JsonNode;

final class ArrivalReplacement implements FieldUpdateStrategy {
    @Override
    public FieldUpdate evaluate(JsonNode current, JsonNode incoming) {
        return FieldUpdate.replaced(incoming.deepCopy());
    }
}
