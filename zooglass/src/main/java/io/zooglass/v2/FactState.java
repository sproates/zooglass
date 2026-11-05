package io.zooglass.v2;

import io.zooglass.strategy.fact.FactRecord;

import java.util.Map;

/** Per-field state survives even when retirement leaves no active records. */
record FactState(
        long floor,
        boolean present,
        Provenance provenance,
        String type,
        Map<Long, FactRecord> records) {
    FactState {
        records = Map.copyOf(records);
    }
}
