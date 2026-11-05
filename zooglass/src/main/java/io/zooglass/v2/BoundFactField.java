package io.zooglass.v2;

import io.zooglass.strategy.fact.ActiveFacts;
import io.zooglass.strategy.fact.FactRevisionSelection;
import io.zooglass.strategy.fact.FactRevisionStrategy;
import java.util.HashMap;

/** Binds one revision policy and projection; all state returned here is staged. */
final class BoundFactField {
    private final V2Configuration.Facts settings;
    private final FactRevisionStrategy revision;
    private final ActiveFacts projection;

    BoundFactField(String mode, V2Configuration.Facts settings) {
        projection = io.zooglass.strategy.fact.FactProjectionSelection.select(mode);
        this.settings = settings;
        revision = FactRevisionSelection.select(settings.revision());
    }

    FactState empty(Provenance provenance, String type) {
        return new FactState(settings.minimumBirthSequence(), false, provenance, type, java.util.Map.of());
    }

    Result evaluate(FactState previous, Publication event) {
        if (event.fact() == null) return new Result(previous, false, "factMetadataRequired");
        var state = previous == null ? empty(new Provenance(event.sourceId(), event.epoch(), event.sourceEntityId()), event.type()) : previous;
        var fact = event.fact();
        if (fact.birthSequence() < state.floor()) return new Result(previous, false, "factOutsideRetention");
        var retained = state.records().get(fact.birthSequence());
        if (retained == null && !fact.operation().equals("create")) throw new FactRejected("unknownFact");
        if (retained == null && state.records().size() >= settings.maxRetainedFacts()) throw new FactRejected("factLimit");
        var decision = revision.evaluate(retained, fact, event.payload());
        if (decision.rejection() != null) return new Result(previous, false, decision.rejection());
        if (decision.replacement() == retained) return new Result(previous, false, null);

        var records = new HashMap<>(state.records());
        records.put(fact.birthSequence(), decision.replacement());
        return new Result(new FactState(state.floor(), true, state.provenance(), state.type(), records), true, null);
    }

    FactState retire(FactState state, long floor) {
        if (floor < state.floor()) throw new FactRejected("backwardsFactFloor");
        if (floor == state.floor()) return state;
        var records = new HashMap<>(state.records());
        records.keySet().removeIf(birth -> birth < floor);
        return new FactState(floor, state.present(), state.provenance(), state.type(), records);
    }

    tools.jackson.databind.JsonNode project(FactState state) { return projection.project(state.records()); }
    record Result(FactState state, boolean changed, String rejection) {}
}
