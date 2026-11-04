package io.zooglass.strategy.identity;

/** A missing lookup is a target rejection, not an ingestion failure. */
public record EntityResolution(String entityId) {
    public boolean resolved() {
        return entityId != null;
    }
}
