package io.zooglass.access;

/** The strategy owns deadlines; the client owns bounded I/O and strict reply decoding. */
interface PolicyClient extends AutoCloseable {

    PolicyReply decide(ViewerCredential credential, ViewResource resource);

    @Override
    default void close() {}
}
