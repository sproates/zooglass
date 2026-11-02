package io.zooglass.strategy.update;

import tools.jackson.databind.JsonNode;

/** A changed result owns its replacement; an unchanged result has none. */
public record FieldUpdate(boolean changed, JsonNode replacement) {
    static FieldUpdate unchanged() {
        return new FieldUpdate(false, null);
    }

    static FieldUpdate replaced(JsonNode replacement) {
        return new FieldUpdate(true, replacement);
    }
}
