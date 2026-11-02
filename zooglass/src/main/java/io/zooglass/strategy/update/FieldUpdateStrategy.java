package io.zooglass.strategy.update;

import tools.jackson.databind.JsonNode;

/** Evaluates one field without mutating either input or retaining entity state. */
public interface FieldUpdateStrategy {
    FieldUpdate evaluate(JsonNode current, JsonNode incoming);
}
