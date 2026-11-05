package io.zooglass.v2;

import java.util.List;
import java.util.Map;

final class FactFixtures {
    private FactFixtures() {}

    static V2Configuration configuration(String storage, long limit, boolean timed) {
        var progress = new V2Configuration.Progress("contiguousSequence", 1L, 30L, 30L);
        return new V2Configuration(2, storage, 10, 10, 20,
                List.of(new V2Configuration.Source("match", "v1", progress)),
                List.of(view("original", "firstFact", limit, timed), view("corrected", "latestFactRevision", limit, timed)));
    }

    static V2Configuration scores(String storage) {
        var base = FactFixtures.configuration(storage, 10, false);
        var views = base.views().stream().map(view -> {
            var goals = view.fields().get("goals");
            var score = new V2Configuration.Field("match", "goal", "sumActiveFacts", null, null, null,
                    goals.freshness(), goals.facts(), "points");
            return new V2Configuration.View(view.id(), Map.of("goals", goals, "score", score));
        }).toList();
        return new V2Configuration(2, storage, 10, 10, 20, base.sources(), views);
    }

    static V2Configuration.View view(String id, String revision, long limit, boolean timed) {
        var freshness = timed ? new V2Configuration.Freshness("receiptAge", 5000L) : null;
        var field = new V2Configuration.Field("match", "goal", "activeFacts", null, null, null, freshness,
                new V2Configuration.Facts(revision, limit, 1L));
        return new V2Configuration.View(id, Map.of("goals", field));
    }

    static Publication event(long publication, long birth, long revision, String operation, String payload) {
        return PublicationJson.parse("""
                {"sourceId":"match","epoch":"v1","sourceEntityId":"game","publicationSequence":%d,
                 "type":"goal","fact":{"birthSequence":%d,"revision":%d,"operation":"%s"},"payload":%s}
                """.formatted(publication, birth, revision, operation, payload));
    }

    static FactRetirement retire(String view, long floor) {
        return new FactRetirement(view, "game", List.of("goals"), floor);
    }

    static ViewCoordinator.Snapshot snapshot(ViewCoordinator service, String view) {
        return service.snapshot(view, "game").orElseThrow();
    }
}
