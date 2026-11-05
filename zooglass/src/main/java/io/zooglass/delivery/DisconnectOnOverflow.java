package io.zooglass.delivery;

public enum DisconnectOnOverflow implements SlowClientPolicy {
    INSTANCE;

    @Override
    public Object keyForUpdate(long generation) {
        return new Object();
    }

    @Override
    public String mode() {
        return "disconnectOnOverflow";
    }
}
