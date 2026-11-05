package io.zooglass.strategy.fact;

import tools.jackson.databind.JsonNode;
import java.util.Map;

/** Computes a field from its own retained facts. */
public interface FactProjection {
    default void validatePayload(JsonNode payload) {}

    JsonNode project(Map<Long, FactRecord> records);
}
