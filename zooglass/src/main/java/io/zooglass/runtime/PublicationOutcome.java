package io.zooglass.runtime;

import java.util.List;

/** Applied is an in-memory outcome, never a promise of durability. */
public record PublicationOutcome(
        String status,
        String reason,
        Publication.StreamKey stream,
        Long publicationSequence,
        Long version,
        List<String> changedViews,
        List<TargetOutcome> targets) {
    public PublicationOutcome(
            String status,
            String reason,
            Publication.StreamKey stream,
            Long publicationSequence,
            Long version,
            List<String> changedViews) {
        this(status, reason, stream, publicationSequence, version, changedViews, List.of());
    }

    static PublicationOutcome malformed() {
        return new PublicationOutcome("rejected", "invalidEnvelope", null, null, null, List.of());
    }
}
