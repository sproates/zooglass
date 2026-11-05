package io.zooglass.runtime;

/** Source identity of the retained or selected contribution. */
public record Provenance(String sourceId, String epoch, String sourceEntityId) {}
