package io.zooglass.v2;

import io.zooglass.strategy.contribution.SelectedContribution;
import io.zooglass.v2.StateImage.StoredView;
import io.zooglass.v2.StateImage.ViewEntity;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Schema 1 used envelope IDs and single-source fields; receipt outcomes were not recorded. */
final class SchemaMigration {

    private SchemaMigration() {}

    static Map<ViewEntity, StoredView> addCandidates(Map<ViewEntity, StoredView> old) {
        var migrated = new HashMap<ViewEntity, StoredView>();
        old.forEach(
                (key, view) -> {
                    var candidates = new HashMap<String, Map<String, SelectedContribution>>();
                    view.data()
                            .forEach(
                                    (field, value) -> {
                                        var provenance = view.provenance().get(field);
                                        candidates.put(
                                                field,
                                                Map.of(
                                                        provenance.sourceId(),
                                                        new SelectedContribution(
                                                                value, provenance)));
                                    });
                    migrated.put(
                            key,
                            new StoredView(
                                    view.version(), view.data(), view.provenance(), candidates));
                });
        return migrated;
    }

    static Map<ViewEntity, StoredView> addProvenance(
            Map<ViewEntity, StoredView> old, V2Configuration configuration) {
        var definitions =
                configuration.views().stream()
                        .collect(Collectors.toMap(V2Configuration.View::id, Function.identity()));
        var epochs =
                configuration.sources().stream()
                        .collect(
                                Collectors.toMap(
                                        V2Configuration.Source::id, V2Configuration.Source::epoch));
        var migrated = new HashMap<ViewEntity, StoredView>();
        for (var entry : old.entrySet()) {
            var definition = definitions.get(entry.getKey().viewId());
            var data = entry.getValue().data();
            if (definition == null || data == null) {
                throw new IllegalStateException("Invalid schema 1 view");
            }
            var provenance = new HashMap<String, Provenance>();
            for (String name : data.keySet()) {
                var field = definition.fields().get(name);
                if (field == null
                        || !"envelopeEntity"
                                .equals(definition.entities().get(field.sourceId()).mode())) {
                    throw new IllegalStateException("Schema 1 requires envelope entity fields");
                }
                provenance.put(
                        name,
                        new Provenance(
                                field.sourceId(),
                                epochs.get(field.sourceId()),
                                entry.getKey().entityId()));
            }
            migrated.put(
                    entry.getKey(),
                    new StoredView(entry.getValue().version(), data, Map.copyOf(provenance)));
        }
        return migrated;
    }
}
