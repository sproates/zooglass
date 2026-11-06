package io.zooglass.access;

import tools.jackson.core.JacksonException;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

import java.util.Map;
import java.util.Set;

/** A small, exact protocol. Unknown fields and coercions fail closed. */
final class PolicyJson {

    private static final JsonMapper JSON = JsonMapper.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();
    private static final Set<String> ALLOW_FIELDS = Set.of("decision", "subject", "lifetimeMillis");

    private PolicyJson() {}

    static byte[] request(String tenant, ViewerCredential credential, ViewResource resource) {
        var body = JSON.createObjectNode();
        body.put("operation", resource == null ? "authenticate" : "read");
        body.put("tenant", tenant);
        body.set("credential", JSON.valueToTree(Map.of(
                "type", credential.kind() == ViewerCredential.Kind.BEARER ? "bearer" : "session",
                "value", credential.value())));
        if (resource != null) {
            body.set("resource", JSON.valueToTree(resource));
        }
        return JSON.writeValueAsBytes(body);
    }

    static PolicyReply response(byte[] bytes) {
        try {
            var body = JSON.readTree(bytes);
            if (body == null || !body.isObject() || !body.path("decision").isTextual()) {
                return PolicyReply.unavailable();
            }
            String decision = body.path("decision").asText();
            if ("allow".equals(decision)) {
                var subject = body.path("subject");
                var lifetime = body.path("lifetimeMillis");
                if (body.size() != 3
                        || body.properties().stream().anyMatch(field -> !ALLOW_FIELDS.contains(field.getKey()))
                        || !subject.isTextual() || subject.asText().isBlank()
                        || subject.asText().length() > 1024
                        || !lifetime.isIntegralNumber() || !lifetime.canConvertToLong()
                        || lifetime.longValue() <= 0) {
                    return PolicyReply.unavailable();
                }
                return new PolicyReply(PolicyReply.Outcome.ALLOW, subject.asText(), lifetime.longValue());
            }
            if (body.size() != 1) {
                return PolicyReply.unavailable();
            }
            return switch (decision) {
                case "unauthenticated" -> new PolicyReply(PolicyReply.Outcome.UNAUTHENTICATED, null, 0);
                case "deny" -> new PolicyReply(PolicyReply.Outcome.DENY, null, 0);
                default -> PolicyReply.unavailable();
            };
        } catch (JacksonException failure) {
            // Parse exceptions can contain the response body. Do not retain or log them.
            return PolicyReply.unavailable();
        }
    }
}
