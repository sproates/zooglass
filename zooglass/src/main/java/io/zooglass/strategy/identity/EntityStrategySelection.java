package io.zooglass.strategy.identity;

import java.util.HashSet;
import java.util.Map;

/** Validate settings and bind the concrete resolver at registration. */
public final class EntityStrategySelection {
    private EntityStrategySelection() {}

    public static EntityResolutionStrategy select(String mode, Map<String, String> keys) {
        if ("envelopeEntity".equals(mode) && keys == null) {
            return new EnvelopeEntity();
        }
        if (!"lookupEntity".equals(mode) || keys == null) {
            throw new IllegalArgumentException("Invalid entity resolution settings");
        }
        var targets = new HashSet<String>();
        for (var entry : keys.entrySet()) {
            if (entry.getKey() == null || entry.getKey().isBlank()
                    || entry.getValue() == null || entry.getValue().isBlank()
                    || !targets.add(entry.getValue())) {
                throw new IllegalArgumentException("Invalid or ambiguous entity mapping");
            }
        }
        return new LookupEntity(keys);
    }
}
