package io.zooglass.strategy.fact;

import tools.jackson.databind.JsonNode;

/** Latest accepted revision, including a tombstone and its canonical comparison content. */
public record FactRecord(long revision, String operation, JsonNode payload) {
    public boolean active() {
        return !"retract".equals(operation);
    }
}
