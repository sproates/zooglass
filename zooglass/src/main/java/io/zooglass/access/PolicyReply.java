package io.zooglass.access;

record PolicyReply(Outcome outcome, String subject, long lifetimeMillis) {

    enum Outcome { ALLOW, UNAUTHENTICATED, DENY, UNAVAILABLE }

    static PolicyReply unavailable() {
        return new PolicyReply(Outcome.UNAVAILABLE, null, 0);
    }
}
