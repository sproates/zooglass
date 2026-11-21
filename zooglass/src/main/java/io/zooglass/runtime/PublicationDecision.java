package io.zooglass.runtime;

import io.zooglass.strategy.update.FieldUpdate;

import java.util.List;

/** Current-attempt facts only. Duplicate receipt targets remain historical in the outcome. */
public record PublicationDecision(
        String format,
        Publication.StreamKey stream,
        Long publicationSequence,
        String status,
        String reason,
        Long version,
        boolean installed,
        List<Target> targets) {
    public PublicationDecision {
        targets = List.copyOf(targets);
    }

    public record Target(String viewId, String entityId, List<Field> fields) {
        public Target {
            fields = List.copyOf(fields);
        }
    }

    /** Public change covers payload value and provenance, not sequence/status metadata. */
    public record Field(
            String field,
            String strategy,
            FieldUpdate.Reason update,
            boolean retainedChanged,
            boolean publicChanged) {}
}
