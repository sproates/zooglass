package io.zooglass.v2;

/** Source identity of the retained single-source field value. */
public record Provenance(String sourceId, String epoch, String sourceEntityId) {}
