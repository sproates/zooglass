package io.zooglass.v2;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Set;

/** A separate control identity: monotonic floors make retries idempotent. */
public record FactRetirement(
        String viewId, String entityId, List<String> fields, long minimumBirthSequence) {
    private static final JsonMapper JSON =
            JsonMapper.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .build();

    public FactRetirement {
        if (viewId == null
                || viewId.isBlank()
                || entityId == null
                || entityId.isBlank()
                || fields == null
                || fields.isEmpty()
                || fields.stream().anyMatch(name -> name == null || name.isBlank())
                || fields.stream().distinct().count() != fields.size()
                || !FactEnvelope.validNumber(minimumBirthSequence)) {
            throw new IllegalArgumentException("Invalid fact retirement");
        }
        fields = fields.stream().sorted().toList();
    }

    static FactRetirement parse(String text) {
        var node = JSON.readTree(text);
        var keys = Set.of("viewId", "entityId", "fields", "minimumBirthSequence");
        if (node == null
                || !node.isObject()
                || node.size() != 4
                || node.properties().stream().anyMatch(entry -> !keys.contains(entry.getKey()))
                || !node.path("viewId").isTextual()
                || !node.path("entityId").isTextual()
                || !node.path("fields").isArray()) {
            throw new IllegalArgumentException("Invalid retirement fields");
        }
        var names = new java.util.ArrayList<String>();
        for (var name : node.path("fields")) {
            if (!name.isTextual()) {
                throw new IllegalArgumentException("Invalid field name");
            }
            names.add(name.asText());
        }
        var floor = node.path("minimumBirthSequence");
        if (!floor.isIntegralNumber() || !floor.canConvertToLong()) {
            throw new IllegalArgumentException("Invalid fact floor");
        }
        return new FactRetirement(
                node.path("viewId").asText(),
                node.path("entityId").asText(),
                names,
                floor.longValue());
    }
}
