package io.zooglass.strategy.progress;

/** Expected contract or capacity rejection, distinct from processing failure. */
public final class ProgressRejected extends RuntimeException {
    private final String reason;

    public ProgressRejected(String reason) {
        super(reason);
        this.reason = reason;
    }

    public String reason() { return reason; }
}
