package io.zooglass.v2;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

import java.util.Set;

/** Separate strict control envelope; controls never occupy data publication identities. */
public record ProgressControl(
        String sourceId, String epoch, String sourceEntityId, long throughSequence) {
    private static final JsonMapper JSON =
            JsonMapper.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .build();
    private static final Set<String> KEYS =
            Set.of("sourceId", "epoch", "sourceEntityId", "throughSequence");

    public Publication.StreamKey stream() {
        return new Publication.StreamKey(sourceId, epoch, sourceEntityId);
    }

    public static ProgressControl parse(String text) {
        var node = JSON.readTree(text);
        if (node == null
                || !node.isObject()
                || node.size() != KEYS.size()
                || node.properties().stream().anyMatch(entry -> !KEYS.contains(entry.getKey()))) {
            throw new IllegalArgumentException("Invalid progress fields");
        }
        for (String key : Set.of("sourceId", "epoch", "sourceEntityId")) {
            if (!node.path(key).isTextual() || node.path(key).asText().isBlank()) {
                throw new IllegalArgumentException("Invalid progress identity");
            }
        }
        var through = node.path("throughSequence");
        if (!through.isIntegralNumber()
                || !through.canConvertToLong()
                || through.longValue() < 1
                || through.longValue() > PublicationJson.MAX_SEQUENCE) {
            throw new IllegalArgumentException("Invalid progress boundary");
        }
        return new ProgressControl(
                node.path("sourceId").asText(),
                node.path("epoch").asText(),
                node.path("sourceEntityId").asText(),
                through.longValue());
    }
}
