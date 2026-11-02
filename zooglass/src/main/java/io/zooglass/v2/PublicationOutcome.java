package io.zooglass.v2;

import java.util.List;

/** Applied is an in-memory outcome, never a promise of durability. */
public record PublicationOutcome(String status, String reason, Publication.StreamKey stream,
        Long publicationSequence, Long version, List<String> changedViews) {
    static PublicationOutcome malformed() {
        return new PublicationOutcome("rejected", "invalidEnvelope", null, null, null, List.of());
    }
}
