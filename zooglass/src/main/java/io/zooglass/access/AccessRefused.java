package io.zooglass.access;

/** Carries only an HTTP status, never credentials or protected resource details. */
public final class AccessRefused extends RuntimeException {
    private final int status;

    AccessRefused(int status) {
        super("Viewer admission refused");
        this.status = status;
    }

    public int status() {
        return status;
    }
}
