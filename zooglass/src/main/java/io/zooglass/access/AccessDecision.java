package io.zooglass.access;

/** Open demo access is distinct from an authenticated, expiring grant. */
public sealed interface AccessDecision {

    record Open() implements AccessDecision {}

    record Granted(AccessGrant grant) implements AccessDecision {}

    record Rejected(Reason reason) implements AccessDecision {}

    enum Reason { UNAUTHENTICATED, DENIED, UNAVAILABLE }
}
