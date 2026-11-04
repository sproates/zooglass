package io.zooglass.strategy.identity;

public interface EntityResolutionStrategy {
    EntityResolution resolve(String sourceEntityId);
}
