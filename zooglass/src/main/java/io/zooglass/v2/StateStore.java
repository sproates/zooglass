package io.zooglass.v2;

/** Storage boundary used only under the coordinator's monitor. */
interface StateStore extends AutoCloseable {
    StateImage current();
    void install(StateImage next);
    boolean durable();

    @Override
    void close();
}
