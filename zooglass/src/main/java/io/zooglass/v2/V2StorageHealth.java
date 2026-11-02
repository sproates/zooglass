package io.zooglass.v2;

import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.stereotype.Component;

/** Storage failure removes service health until restart recovery succeeds. */
@Component
public final class V2StorageHealth implements HealthIndicator {
    private final ViewCoordinator coordinator;

    public V2StorageHealth(ViewCoordinator coordinator) {
        this.coordinator = coordinator;
    }

    @Override
    public Health health() {
        return coordinator.healthy() ? Health.up().build() : Health.down().build();
    }
}
