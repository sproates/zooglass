package io.zooglass.v2;

import io.zooglass.strategy.fact.FactProjection;
import io.zooglass.strategy.fact.FactProjectionSelection;
import io.zooglass.strategy.fact.SumActiveFacts.InvalidContribution;
import io.zooglass.strategy.fact.FactRevisionSelection;
import io.zooglass.strategy.fact.FactRevisionStrategy;
import java.util.HashMap;

/** Binds one revision policy and projection; all state returned here is staged. */
final class BoundFactField {
    private final V2Configuration.Facts settings;
    private final FactRevisionStrategy revision;
    private final FactProjection projection;

    BoundFactField(String mode, String property, V2Configuration.Facts settings) {
        projection = FactProjectionSelection.select(mode, property);
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
        if (!fact.operation().equals("retract")) {
            try {
                projection.validatePayload(event.payload());
            } catch (InvalidContribution failure) {
                throw new FactRejected(failure.getMessage());
            }
        }
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

    tools.jackson.databind.JsonNode project(FactState state) {
        try {
            return projection.project(state.records());
        } catch (InvalidContribution failure) {
            throw new FactRejected(failure.getMessage());
        }
    }
    record Result(FactState state, boolean changed, String rejection) {}
}
