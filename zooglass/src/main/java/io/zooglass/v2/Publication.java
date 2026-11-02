package io.zooglass.v2;

import tools.jackson.databind.JsonNode;

/** Identity is independent of event type and content. Epoch is configured, not inferred. */
public record Publication(String sourceId, String epoch, String sourceEntityId,
        long publicationSequence, String type, JsonNode payload) {
    public StreamKey stream() {
        return new StreamKey(sourceId, epoch, sourceEntityId);
    }

    public record StreamKey(String sourceId, String epoch, String sourceEntityId) {}
}
