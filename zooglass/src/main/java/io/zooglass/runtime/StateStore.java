package io.zooglass.runtime;

/** Storage boundary used only under the coordinator's monitor. */
interface StateStore extends AutoCloseable {
    StateImage current();

    void install(StateImage next);

    void configure(
            RuntimeConfiguration configuration,
            java.util.function.UnaryOperator<StateImage> prepare);

    boolean durable();

    @Override
    void close();
}
