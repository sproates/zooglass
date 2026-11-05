package io.zooglass.strategy.fact;

import io.zooglass.runtime.FactEnvelope;

import tools.jackson.databind.JsonNode;

public final class FirstFact implements FactRevisionStrategy {

    public Decision evaluate(FactRecord previous, FactEnvelope fact, JsonNode payload) {
        return previous == null ? Decision.accept(fact, payload) : Decision.reject("factImmutable");
    }
}
