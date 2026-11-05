package io.zooglass.strategy.identity;

import java.util.Map;

/** Exact, immutable, source-local relationship table. */
public final class LookupEntity implements EntityResolutionStrategy {

    private final Map<String, String> keys;

    public LookupEntity(Map<String, String> keys) {
        this.keys = Map.copyOf(keys);
    }

    @Override
    public EntityResolution resolve(String sourceEntityId) {
        return new EntityResolution(keys.get(sourceEntityId));
    }
}
