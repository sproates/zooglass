package io.zooglass.delivery;

import com.fasterxml.jackson.annotation.JsonProperty;

import io.zooglass.runtime.ViewCoordinator;

import java.util.List;

/** Starts each subscription with the complete state captured for this generation. */
public enum FreshSnapshot {
    @JsonProperty(FreshSnapshot.MODE)
    INSTANCE;

    public static final String MODE = "freshSnapshot";

    List<Object> openingMessages(ViewCoordinator.Snapshot baseline) {
        return List.of(
                new Acknowledgement("subscribed", baseline.viewId(), baseline.entityId(), MODE),
                ViewUpdate.from(baseline));
    }

    private record Acknowledgement(String type, String viewId, String entityId, String recovery) {}
}
