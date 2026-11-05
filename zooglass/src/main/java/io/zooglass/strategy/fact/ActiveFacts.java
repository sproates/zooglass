package io.zooglass.strategy.fact;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;

import java.util.Map;
import java.util.TreeMap;

/** A detached current collection in birth order, not a history of revision deliveries. */
public final class ActiveFacts implements FactProjection {

    public JsonNode project(Map<Long, FactRecord> records) {
        var result = JsonNodeFactory.instance.arrayNode();
        new TreeMap<>(records)
                .forEach(
                        (birth, record) -> {
                            if (record.active()) {
                                result.add(
                                        JsonNodeFactory.instance
                                                .objectNode()
                                                .put("birthSequence", birth)
                                                .put("revision", record.revision())
                                                .set("payload", record.payload().deepCopy()));
                            }
                        });
        return result;
    }
}
