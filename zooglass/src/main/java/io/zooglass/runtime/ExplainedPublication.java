package io.zooglass.runtime;

/** Optional in-process result; neither member changes the service receipt or storage schema. */
public record ExplainedPublication(PublicationOutcome outcome, PublicationDecision decision) {}
