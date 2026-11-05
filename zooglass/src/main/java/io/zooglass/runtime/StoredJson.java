package io.zooglass.runtime;

import org.springframework.boot.jackson.autoconfigure.JsonFactoryBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamWriteConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;

/** JSON that retains its content when persisted as UTF-8, including inside runtime envelopes. */
@Configuration(proxyBeanMethods = false)
class StoredJson {
    // Storage rows, HTTP snapshots and live notifications wrap accepted source values.
    private static final int WRAPPED_DEPTH =
            StreamReadConstraints.defaults().getMaxNestingDepth() + 32;
    private static final StreamWriteConstraints OUTPUT =
            StreamWriteConstraints.defaults().rebuild().maxNestingDepth(WRAPPED_DEPTH).build();

    static JsonFactory rowFactory() {
        return JsonFactory.builder()
                .streamReadConstraints(
                        StreamReadConstraints.defaults()
                                .rebuild()
                                .maxNestingDepth(WRAPPED_DEPTH)
                                .build())
                .streamWriteConstraints(OUTPUT)
                .build();
    }

    @Bean
    JsonFactoryBuilderCustomizer snapshotOutputDepth() {
        return builder -> builder.streamWriteConstraints(OUTPUT);
    }

    static void validateStrings(JsonNode node) {
        validate(node, 1);
    }

    static void validatePayload(JsonNode payload) {
        // The publication envelope occupies the first container level on the wire.
        validate(payload, 2);
    }

    private static void validate(JsonNode node, int depth) {
        if (node == null) return;
        if (node.isContainer() && depth > StreamReadConstraints.defaults().getMaxNestingDepth()) {
            throw new IllegalArgumentException("JSON nesting exceeds the publication limit");
        }
        if (node.isTextual()) requireUnicode(node.stringValue());
        else if (node.isObject()) {
            node.properties()
                    .forEach(
                            entry -> {
                                requireUnicode(entry.getKey());
                                validate(entry.getValue(), depth + 1);
                            });
        } else if (node.isArray()) node.forEach(item -> validate(item, depth + 1));
    }

    static void requireUnicode(String text) {
        if (text == null) return; // Required-field validation belongs to the envelope.
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isSurrogate(c)) {
                if (i + 1 == text.length() || !Character.isSurrogatePair(c, text.charAt(i + 1))) {
                    throw new IllegalArgumentException("Unpaired Unicode surrogate");
                }
                i++;
            }
        }
    }
}
