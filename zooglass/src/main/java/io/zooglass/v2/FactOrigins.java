package io.zooglass.v2;

import java.util.Map;

/** Consult the retained birth/type index represented by field records, before type routing. */
final class FactOrigins {

    private FactOrigins() {}

    static void validate(Publication event, StateImage image, Map<String, BoundView> views) {
        if (event.fact() == null) {
            return;
        }
        for (var binding : views.values()) {
            var resolved = binding.resolve(event.stream());
            if (resolved == null || !resolved.resolved()) {
                continue;
            }
            var row =
                    image.views().get(new StateImage.ViewEntity(binding.id(), resolved.entityId()));
            if (row == null) {
                continue;
            }
            for (var facts : row.facts().values()) {
                var origin = facts.provenance();
                if (origin.sourceId().equals(event.sourceId())
                        && origin.epoch().equals(event.epoch())
                        && origin.sourceEntityId().equals(event.sourceEntityId())
                        && facts.records().containsKey(event.fact().birthSequence())
                        && !facts.type().equals(event.type())) {
                    throw new FactRejected("factTypeMismatch");
                }
            }
        }
    }
}
