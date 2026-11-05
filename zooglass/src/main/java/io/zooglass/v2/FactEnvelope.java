package io.zooglass.v2;

import tools.jackson.databind.JsonNode;

import java.util.Set;

/** Delivery metadata for one stable source fact; deliberately separate from its payload. */
public record FactEnvelope(long birthSequence, long revision, String operation) {
    public FactEnvelope {
        if (!validNumber(birthSequence)
                || !validNumber(revision)
                || !Set.of("create", "revise", "retract").contains(operation)) {
            throw new IllegalArgumentException("Invalid fact metadata");
        }
    }

    static FactEnvelope parse(JsonNode node, long publication, JsonNode payload) {
        if (!node.isObject() || node.size() != 3 || !node.path("operation").isTextual()) {
            throw new IllegalArgumentException("Invalid fact metadata");
        }
        var birth = node.path("birthSequence");
        var revision = node.path("revision");
        if (!birth.isIntegralNumber()
                || !birth.canConvertToLong()
                || !revision.isIntegralNumber()
                || !revision.canConvertToLong()) {
            throw new IllegalArgumentException("Invalid fact numbers");
        }
        var fact =
                new FactEnvelope(
                        birth.longValue(), revision.longValue(), node.path("operation").asText());
        fact.validate(publication, payload);
        return fact;
    }

    void validate(long publication, JsonNode payload) {
        boolean create = operation.equals("create");
        if (create
                ? birthSequence != publication || revision != 1
                : publication <= birthSequence || revision < 2) {
            throw new IllegalArgumentException("Invalid fact publication");
        }
        if (operation.equals("retract") && !payload.isEmpty()) {
            throw new IllegalArgumentException("Retraction requires empty payload");
        }
    }

    public static boolean validNumber(long number) {
        return number >= 1 && number <= PublicationJson.MAX_SEQUENCE;
    }
}
