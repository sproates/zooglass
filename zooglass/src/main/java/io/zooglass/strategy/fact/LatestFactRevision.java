package io.zooglass.strategy.fact;

import io.zooglass.v2.FactEnvelope;
import io.zooglass.v2.PublicationJson;
import tools.jackson.databind.JsonNode;

public final class LatestFactRevision implements FactRevisionStrategy {
    public Decision evaluate(FactRecord previous, FactEnvelope fact, JsonNode payload) {
        if (previous == null || fact.revision() > previous.revision()) return Decision.accept(fact, payload);
        if (fact.revision() < previous.revision()) return Decision.reject("obsoleteRevision");
        if (!fact.operation().equals(previous.operation())
                || !PublicationJson.content(payload).equals(PublicationJson.content(previous.payload()))) {
            return Decision.reject("revisionConflict");
        }
        return new Decision(previous, null);
    }
}
