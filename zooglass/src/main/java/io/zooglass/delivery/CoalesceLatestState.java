package io.zooglass.delivery;

public enum CoalesceLatestState implements SlowClientPolicy {
    INSTANCE;

    @Override
    public Object keyForUpdate(long generation) {
        return generation;
    }

    @Override
    public String mode() {
        return "coalesceLatestState";
    }
}
