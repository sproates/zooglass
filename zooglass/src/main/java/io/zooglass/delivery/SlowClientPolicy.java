package io.zooglass.delivery;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/** Selects which waiting ordinary updates can replace one another. */
public sealed interface SlowClientPolicy permits DisconnectOnOverflow, CoalesceLatestState {
    Object keyForUpdate(long generation);

    @JsonValue
    String mode();

    @JsonCreator
    static SlowClientPolicy select(String mode) {
        return switch (mode) {
            case "disconnectOnOverflow" -> DisconnectOnOverflow.INSTANCE;
            case "coalesceLatestState" -> CoalesceLatestState.INSTANCE;
            default ->
                    throw new IllegalArgumentException("Unsupported slow-client policy: " + mode);
        };
    }
}
