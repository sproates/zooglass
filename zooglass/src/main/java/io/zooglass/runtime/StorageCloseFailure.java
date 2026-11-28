package io.zooglass.runtime;

import java.sql.SQLException;

/** Identifies a failed close after the coordinator releases its monitor. */
final class StorageCloseFailure extends IllegalStateException {
    StorageCloseFailure(SQLException cause) {
        super("Cannot close SQLite database", cause);
    }
}
