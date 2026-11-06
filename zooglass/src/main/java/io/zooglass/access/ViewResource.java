package io.zooglass.access;

/** The decoded IDs used by the snapshot lookup, without case or path normalisation. */
public record ViewResource(String viewId, String entityId) {

    public ViewResource {
        if (viewId == null || viewId.isBlank() || entityId == null || entityId.isBlank()) {
            throw new IllegalArgumentException("View and entity IDs are required");
        }
    }
}
