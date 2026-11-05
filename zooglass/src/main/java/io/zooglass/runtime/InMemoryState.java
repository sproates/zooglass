package io.zooglass.runtime;

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
    public void configure(
            RuntimeConfiguration configuration,
            java.util.function.UnaryOperator<StateImage> prepare) {
        current = prepare.apply(current);
    }

    @Override
    public boolean durable() {
        return false;
    }

    @Override
    public void close() {}
}
