package io.zooglass.v2;

import io.zooglass.strategy.fact.FactProjectionSelection;
import io.zooglass.strategy.identity.EntityStrategySelection;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/** Validates retained facts and recomputed projections before the service becomes ready. */
final class FactRecovery {
    private FactRecovery() {}

    static void validate(StateImage image, V2Configuration configuration) {
        var origins = new HashMap<Origin, String>();
        for (var entry : image.views().entrySet()) {
            var definition = configuration.views().stream().filter(v -> v.id().equals(entry.getKey().viewId()))
                    .findFirst().orElseThrow(() -> new IllegalStateException("Unknown retained view"));
            var row = entry.getValue();
            for (var field : row.facts().entrySet()) {
                var config = definition.fields().get(field.getKey());
                var facts = field.getValue();
                require(config != null && config.facts() != null && facts != null);
                var input = config.allInputs().getFirst();
                var provenance = facts.provenance();
                require(provenance != null && input.sourceId().equals(provenance.sourceId()) && input.type().equals(facts.type()));
                var source = configuration.sources().stream().filter(s -> s.id().equals(input.sourceId())).findFirst().orElseThrow();
                require(source.epoch().equals(provenance.epoch()) && provenance.sourceEntityId() != null && !provenance.sourceEntityId().isBlank());
                var resolver = definition.entities().get(input.sourceId());
                require(entry.getKey().entityId().equals(EntityStrategySelection.select(resolver.mode(), resolver.keys())
                        .resolve(provenance.sourceEntityId()).entityId()));
                var stream = new Publication.StreamKey(provenance.sourceId(), provenance.epoch(), provenance.sourceEntityId());
                require(image.streams().containsKey(stream));
                require(FactEnvelope.validNumber(facts.floor()) && facts.floor() >= config.facts().minimumBirthSequence()
                        && facts.records().size() <= config.facts().maxRetainedFacts());
                require(facts.present() || facts.records().isEmpty());
                for (var retained : facts.records().entrySet()) {
                    long birth = retained.getKey();
                    var record = retained.getValue();
                    require(birth >= facts.floor() && FactEnvelope.validNumber(birth) && record != null
                            && FactEnvelope.validNumber(record.revision()) && record.payload() != null && record.payload().isObject()
                            && Set.of("create", "revise", "retract").contains(record.operation()));
                    require(record.operation().equals("create") ? record.revision() == 1 : record.revision() >= 2);
                    require(!record.operation().equals("retract") || record.payload().isEmpty());
                    require(!config.facts().revision().equals("firstFact") || record.operation().equals("create"));
                    String previousType = origins.putIfAbsent(new Origin(stream, birth), facts.type());
                    require(previousType == null || previousType.equals(facts.type()));
                }
                var candidates = row.candidates().get(field.getKey());
                if (!facts.present()) {
                    require(candidates == null);
                } else {
                    require(candidates != null && candidates.keySet().equals(Set.of(input.sourceId())));
                    var candidate = candidates.get(input.sourceId());
                    require(candidate != null && provenance.equals(candidate.provenance())
                            && PublicationJson.content(FactProjectionSelection.select(config.mode(), config.property()).project(facts.records()))
                                    .equals(PublicationJson.content(candidate.value())));
                }
            }
            for (var field : definition.fields().entrySet()) {
                if (field.getValue().facts() != null && row.candidates().containsKey(field.getKey())) {
                    require(row.facts().containsKey(field.getKey()));
                }
            }
        }
    }

    static boolean owns(StateImage image, Publication.StreamKey stream) {
        return image.views().values().stream().flatMap(row -> row.facts().values().stream()).anyMatch(facts ->
                facts.provenance() != null && facts.provenance().sourceId().equals(stream.sourceId())
                        && facts.provenance().epoch().equals(stream.epoch())
                        && facts.provenance().sourceEntityId().equals(stream.sourceEntityId()));
    }

    static boolean policyRejection(String reason, V2Configuration.Field field) {
        return field.facts() != null && Set.of("factMetadataRequired", "factOutsideRetention", "factImmutable",
                "obsoleteRevision", "revisionConflict").contains(reason);
    }

    private static void require(boolean valid) {
        if (!valid) throw new IllegalStateException("Invalid recovered fact state");
    }

    private record Origin(Publication.StreamKey stream, long birth) {}
}
