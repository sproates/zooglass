package io.zooglass.v2;

import java.util.List;
import java.util.Map;

final class IdentityFixtures {

    private IdentityFixtures() {}

    static V2Configuration configuration(int streams, int window, int history) {
        return new V2Configuration(
                2,
                "memory",
                streams,
                window,
                history,
                List.of(
                        new V2Configuration.Source("fleet", "trip-1"),
                        new V2Configuration.Source("backup", "trip-1")),
                List.of(
                        view("latest", "latestBySequence"),
                        view("history", "historyBySequence"),
                        view("arrival", "arrival")));
    }

    static V2Configuration.View view(String id, String mode) {
        return new V2Configuration.View(
                id, Map.of("position", new V2Configuration.Field("fleet", "position", mode)));
    }

    static Publication event(long sequence) {
        return parse(
                "fleet", "trip-1", "car", sequence, "position", "{\"value\":" + sequence + "}");
    }

    static Publication parse(
            String source,
            String epoch,
            String entity,
            long sequence,
            String type,
            String payload) {
        return PublicationJson.parse(
                """
                {"sourceId":"%s","epoch":"%s","sourceEntityId":"%s",
                 "publicationSequence":%d,"type":"%s","payload":%s}
                """
                        .formatted(source, epoch, entity, sequence, type, payload));
    }

    static String envelope(int sequence, String payload) {
        return """
        {"sourceId":"fleet","epoch":"trip-1","sourceEntityId":"car",
         "publicationSequence":%d,"type":"position","payload":%s}
        """
                .formatted(sequence, payload);
    }
}
