package io.zooglass.v2;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.Set;
import java.util.TreeMap;

/** Strict envelope parsing and structural comparison; never includes payloads in errors. */
public final class PublicationJson {
    public static final long MAX_SEQUENCE = 9_007_199_254_740_991L;
    private static final JsonMapper JSON = JsonMapper.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();
    private static final Set<String> FIELDS = Set.of(
            "sourceId", "epoch", "sourceEntityId", "publicationSequence", "type", "payload", "fact");

    private PublicationJson() {}

    public static Publication parse(String text) {
        JsonNode node = JSON.readTree(text);
        if (node == null || !node.isObject() || (node.size() != 6 && node.size() != 7)
                || node.properties().stream().anyMatch(entry -> !FIELDS.contains(entry.getKey()))) {
            throw new IllegalArgumentException("Invalid publication fields");
        }
        for (String key : Set.of("sourceId", "epoch", "sourceEntityId", "type")) {
            if (!node.path(key).isTextual() || node.path(key).asText().isBlank()) {
                throw new IllegalArgumentException("Invalid identity or type");
            }
        }
        JsonNode sequence = node.path("publicationSequence");
        if (!sequence.isIntegralNumber() || !sequence.canConvertToLong()
                || sequence.longValue() < 1 || sequence.longValue() > MAX_SEQUENCE
                || !node.path("payload").isObject()) {
            throw new IllegalArgumentException("Invalid sequence or payload");
        }
        return new Publication(node.get("sourceId").asText(), node.get("epoch").asText(),
                node.get("sourceEntityId").asText(), sequence.longValue(),
                node.get("type").asText(), node.get("payload"),
                node.has("fact") ? FactEnvelope.parse(node.get("fact"), sequence.longValue(), node.get("payload")) : null);
    }

    public static Object content(JsonNode value) {
        if (value.isNumber()) {
            return value.decimalValue().stripTrailingZeros();
        }
        if (value.isObject()) {
            var fields = new TreeMap<String, Object>();
            value.properties().forEach(entry -> fields.put(entry.getKey(), content(entry.getValue())));
            return fields;
        }
        if (value.isArray()) {
            var items = new java.util.ArrayList<Object>();
            value.forEach(item -> items.add(content(item)));
            return items;
        }
        // Preserve type distinctions: null, boolean and string are not interchangeable.
        return value.deepCopy();
    }
}
