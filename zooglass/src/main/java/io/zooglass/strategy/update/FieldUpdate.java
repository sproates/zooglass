package io.zooglass.strategy.update;

import tools.jackson.databind.JsonNode;

import java.util.Objects;

/** A changed result owns its replacement; the reason comes from the deciding strategy. */
public record FieldUpdate(boolean changed, JsonNode replacement, Reason reason) {
    public enum Reason {
        ARRIVAL_REPLACED,
        SEQUENCE_MISSING,
        LATEST_INITIAL,
        LATEST_NEWER,
        LATEST_EQUAL,
        LATEST_OLDER,
        HISTORY_INSERTED,
        HISTORY_EXISTING
    }

    public FieldUpdate {
        Objects.requireNonNull(reason);
    }

    static FieldUpdate unchanged(Reason reason) {
        return new FieldUpdate(false, null, reason);
    }

    static FieldUpdate replaced(JsonNode replacement, Reason reason) {
        return new FieldUpdate(true, replacement, reason);
    }
}
