package io.zooglass.v2;

/** Owns an installed memory image, with no durability claim. */
final class InMemoryState implements StateStore {
    private StateImage current = StateImage.empty();

    @Override
    public StateImage current() {
        return current;
    }

    @Override
    public void install(StateImage next) {
        current = next;
    }

    @Override
    public boolean durable() {
        return false;
    }

    @Override
    public void close() {}
}
