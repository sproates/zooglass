package io.zooglass.runtime;

import java.util.List;
import java.util.Map;

final class FactFixtures {

    private FactFixtures() {}

    static RuntimeConfiguration configuration(String storage, long limit, boolean timed) {
        var progress = new RuntimeConfiguration.Progress("contiguousSequence", 1L, 30L, 30L);
        return new RuntimeConfiguration(
                2,
                storage,
                10,
                10,
                20,
                List.of(new RuntimeConfiguration.Source("match", "v1", progress)),
                List.of(
                        view("original", "firstFact", limit, timed),
                        view("corrected", "latestFactRevision", limit, timed)));
    }

    static RuntimeConfiguration scores(String storage) {
        var base = FactFixtures.configuration(storage, 10, false);
        var views =
                base.views().stream()
                        .map(
                                view -> {
                                    var goals = view.fields().get("goals");
                                    var score =
                                            new RuntimeConfiguration.Field(
                                                    "match",
                                                    "goal",
                                                    "sumActiveFacts",
                                                    null,
                                                    null,
                                                    null,
                                                    goals.freshness(),
                                                    goals.facts(),
                                                    "points");
                                    return new RuntimeConfiguration.View(
                                            view.id(), Map.of("goals", goals, "score", score));
                                })
                        .toList();
        return new RuntimeConfiguration(2, storage, 10, 10, 20, base.sources(), views);
    }

    static RuntimeConfiguration.View view(String id, String revision, long limit, boolean timed) {
        var freshness = timed ? new RuntimeConfiguration.Freshness("receiptAge", 5000L) : null;
        var field =
                new RuntimeConfiguration.Field(
                        "match",
                        "goal",
                        "activeFacts",
                        null,
                        null,
                        null,
                        freshness,
                        new RuntimeConfiguration.Facts(revision, limit, 1L));
        return new RuntimeConfiguration.View(id, Map.of("goals", field));
    }

    static Publication event(
            long publication, long birth, long revision, String operation, String payload) {
        return PublicationJson.parse(
                """
                {"sourceId":"match","epoch":"v1","sourceEntityId":"game","publicationSequence":%d,
                 "type":"goal","fact":{"birthSequence":%d,"revision":%d,"operation":"%s"},"payload":%s}
                """
                        .formatted(publication, birth, revision, operation, payload));
    }

    static FactRetirement retire(String view, long floor) {
        return new FactRetirement(view, "game", List.of("goals"), floor);
    }

    static ViewCoordinator.Snapshot snapshot(ViewCoordinator service, String view) {
        return service.snapshot(view, "game").orElseThrow();
    }
}
