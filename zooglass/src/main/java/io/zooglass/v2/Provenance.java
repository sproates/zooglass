package io.zooglass.v2;

/** Source identity of the retained or selected contribution. */
public record Provenance(String sourceId, String epoch, String sourceEntityId) {}
