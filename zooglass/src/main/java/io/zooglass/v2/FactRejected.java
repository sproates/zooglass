package io.zooglass.v2;

import java.util.List;

/** Abort the complete staged publication; no identity or progress is consumed. */
final class FactRejected extends RuntimeException {

    private final String reason;
    private final List<TargetOutcome> targets;

    FactRejected(String reason) {
        this(reason, List.of());
    }

    FactRejected(String reason, List<TargetOutcome> targets) {
        this.reason = reason;
        this.targets = List.copyOf(targets);
    }

    FactRejected at(String view, String entity, String field) {
        var outcome = new TargetOutcome.FieldOutcome(field, "rejected", reason, false);
        return new FactRejected(
                reason,
                List.of(
                        new TargetOutcome(
                                view, entity, "rejected", reason, List.of(), List.of(outcome))));
    }

    String reason() {
        return reason;
    }

    List<TargetOutcome> targets() {
        return targets;
    }
}
