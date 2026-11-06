package io.zooglass.access;

public final class OpenDemoAccess implements ViewerAccess {

    private static final AccessDecision OPEN = new AccessDecision.Open();

    @Override
    public AccessDecision authenticate(ViewerCredential credential) {
        return OPEN;
    }

    @Override
    public AccessDecision authorise(ViewerCredential credential, ViewResource resource) {
        return OPEN;
    }

    @Override
    public void close() {}
}
