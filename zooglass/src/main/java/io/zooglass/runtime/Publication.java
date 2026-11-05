package io.zooglass.runtime;

import tools.jackson.databind.JsonNode;

/** Identity is independent of event type and content. Epoch is configured, not inferred. */
public record Publication(
        String sourceId,
        String epoch,
        String sourceEntityId,
        long publicationSequence,
        String type,
        JsonNode payload,
        @com.fasterxml.jackson.annotation.JsonInclude(
                        com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                FactEnvelope fact) {
    public Publication {
        StoredJson.requireUnicode(sourceId);
        StoredJson.requireUnicode(epoch);
        StoredJson.requireUnicode(sourceEntityId);
        StoredJson.requireUnicode(type);
        StoredJson.validatePayload(payload);
    }

    public Publication(
            String sourceId,
            String epoch,
            String sourceEntityId,
            long publicationSequence,
            String type,
            JsonNode payload) {
        this(sourceId, epoch, sourceEntityId, publicationSequence, type, payload, null);
    }

    public StreamKey stream() {
        return new StreamKey(sourceId, epoch, sourceEntityId);
    }

    public record StreamKey(String sourceId, String epoch, String sourceEntityId) {}
}
