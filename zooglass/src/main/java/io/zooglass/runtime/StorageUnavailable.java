package io.zooglass.runtime;

/** The store already owns its terminal loss-of-availability diagnostic. */
final class StorageUnavailable extends IllegalStateException {
    StorageUnavailable(String message, Throwable cause) {
        super(message, cause);
    }
}
