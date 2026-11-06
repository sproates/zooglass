package io.zooglass.access;

/** Admission decisions only; delivery must separately enforce and invalidate active grants. */
public interface ViewerAccess extends AutoCloseable {

    AccessDecision authenticate(ViewerCredential credential);

    AccessDecision authorise(ViewerCredential credential, ViewResource resource);

    @Override
    void close();
}
