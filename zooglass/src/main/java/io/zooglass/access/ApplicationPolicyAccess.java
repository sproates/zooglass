package io.zooglass.access;

import java.util.Objects;
import java.util.function.LongSupplier;

public final class ApplicationPolicyAccess implements ViewerAccess {

    private final String tenant;
    private final PolicyClient client;
    private final LongSupplier clock;

    ApplicationPolicyAccess(String tenant, PolicyClient client, LongSupplier clock) {
        this.tenant = tenant;
        this.client = client;
        this.clock = clock;
    }

    @Override
    public AccessDecision authenticate(ViewerCredential credential) {
        return decide(credential, null);
    }

    @Override
    public AccessDecision authorise(ViewerCredential credential, ViewResource resource) {
        return decide(credential, Objects.requireNonNull(resource));
    }

    private AccessDecision decide(ViewerCredential credential, ViewResource resource) {
        if (credential == null) {
            return new AccessDecision.Rejected(AccessDecision.Reason.UNAUTHENTICATED);
        }
        long started = clock.getAsLong();
        var reply = client.decide(credential, resource);
        return switch (reply.outcome()) {
            case UNAUTHENTICATED -> new AccessDecision.Rejected(AccessDecision.Reason.UNAUTHENTICATED);
            case DENY -> new AccessDecision.Rejected(AccessDecision.Reason.DENIED);
            case UNAVAILABLE -> new AccessDecision.Rejected(AccessDecision.Reason.UNAVAILABLE);
            case ALLOW -> {
                var grant = new AccessGrant(tenant, reply.subject(), resource,
                        started, reply.lifetimeMillis(), clock);
                yield grant.isCurrent()
                        ? new AccessDecision.Granted(grant)
                        : new AccessDecision.Rejected(AccessDecision.Reason.UNAVAILABLE);
            }
        };
    }

    @Override
    public void close() {
        client.close();
    }
}
