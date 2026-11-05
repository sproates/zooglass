package io.zooglass.strategy.fact;

import io.zooglass.runtime.FactEnvelope;

import tools.jackson.databind.JsonNode;

public interface FactRevisionStrategy {
    Decision evaluate(FactRecord previous, FactEnvelope fact, JsonNode payload);

    record Decision(FactRecord replacement, String rejection) {
        public static Decision reject(String reason) {
            return new Decision(null, reason);
        }

        public static Decision accept(FactEnvelope fact, JsonNode payload) {
            return new Decision(
                    new FactRecord(fact.revision(), fact.operation(), payload.deepCopy()), null);
        }
    }
}
