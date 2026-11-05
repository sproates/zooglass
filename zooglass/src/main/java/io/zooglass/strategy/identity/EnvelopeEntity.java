package io.zooglass.strategy.identity;

public final class EnvelopeEntity implements EntityResolutionStrategy {

    @Override
    public EntityResolution resolve(String sourceEntityId) {
        return new EntityResolution(sourceEntityId);
    }
}
