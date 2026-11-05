package io.zooglass.delivery;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

import io.zooglass.api.ViewSnapshot;
import io.zooglass.runtime.ViewCoordinator;

/** The HTTP snapshot fields with the live protocol's message type. */
record ViewUpdate(String type, @JsonUnwrapped ViewSnapshot snapshot) {
    static ViewUpdate from(ViewCoordinator.Snapshot snapshot) {
        return new ViewUpdate("view-update", ViewSnapshot.from(snapshot));
    }
}
