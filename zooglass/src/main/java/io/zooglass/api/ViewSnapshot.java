package io.zooglass.api;

import io.zooglass.runtime.Provenance;
import io.zooglass.runtime.ViewCoordinator;
import io.zooglass.runtime.ViewStatus;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Public values and their evidence; retained contribution envelopes stay inside the runtime. */
public record ViewSnapshot(
        String viewId,
        String entityId,
        long version,
        Map<String, JsonNode> data,
        Map<String, Provenance> provenance,
        Map<String, List<Long>> publicationSequences,
        ViewStatus.Status status) {
    public static ViewSnapshot from(ViewCoordinator.Snapshot snapshot) {
        var values = new LinkedHashMap<String, JsonNode>();
        var sequences = new LinkedHashMap<String, List<Long>>();
        snapshot.data()
                .forEach(
                        (name, retained) -> {
                            if (snapshot.status().fields().get(name).facts() != null) {
                                values.put(name, retained.deepCopy());
                            } else if (retained.isArray()) {
                                var history = JsonNodeFactory.instance.arrayNode();
                                var identities = new ArrayList<Long>();
                                for (var contribution : retained) {
                                    history.add(contribution.path("payload").deepCopy());
                                    identities.add(
                                            contribution.path("publicationSequence").longValue());
                                }
                                values.put(name, history);
                                sequences.put(name, List.copyOf(identities));
                            } else {
                                values.put(name, retained.path("payload").deepCopy());
                                sequences.put(
                                        name,
                                        List.of(retained.path("publicationSequence").longValue()));
                            }
                        });
        return new ViewSnapshot(
                snapshot.viewId(),
                snapshot.entityId(),
                snapshot.version(),
                Map.copyOf(values),
                snapshot.provenance(),
                Map.copyOf(sequences),
                snapshot.status());
    }
}
