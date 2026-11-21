package io.zooglass.runtime;

import io.zooglass.api.ViewSnapshot;
import io.zooglass.strategy.update.FieldUpdate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Attempt-local staging. Nothing escapes until the coordinator returns successfully. */
final class PublicationExplanation {
    private final List<PublicationDecision.Target> targets = new ArrayList<>();
    private ExplainedPublication installed;

    static final class Target {
        private record Update(
                String field, String strategy, FieldUpdate.Reason reason, boolean changed) {}

        private final List<Update> updates = new ArrayList<>();

        void update(String field, String strategy, FieldUpdate update) {
            updates.add(new Update(field, strategy, update.reason(), update.changed()));
        }
    }

    void target(
            Target target,
            ViewTransitions.Binding binding,
            String entity,
            StateImage.StoredView before,
            StateImage.StoredView after,
            Map<Publication.StreamKey, StateImage.StreamState> beforeStreams,
            Map<Publication.StreamKey, StateImage.StreamState> afterStreams) {
        var previous = project(binding, entity, before, beforeStreams);
        var next = project(binding, entity, after, afterStreams);
        var fields =
                target.updates.stream()
                        .map(
                                update ->
                                        new PublicationDecision.Field(
                                                update.field(),
                                                update.strategy(),
                                                update.reason(),
                                                update.changed(),
                                                !Objects.equals(
                                                                previous.data().get(update.field()),
                                                                next.data().get(update.field()))
                                                        || !Objects.equals(
                                                                previous.provenance()
                                                                        .get(update.field()),
                                                                next.provenance()
                                                                        .get(update.field()))))
                        .toList();
        targets.add(new PublicationDecision.Target(binding.id(), entity, fields));
    }

    private static ViewSnapshot project(
            ViewTransitions.Binding binding,
            String entity,
            StateImage.StoredView stored,
            Map<Publication.StreamKey, StateImage.StreamState> streams) {
        return ViewSnapshot.from(
                new ViewCoordinator.Snapshot(
                        binding.id(),
                        entity,
                        stored == null ? 0 : stored.version(),
                        stored == null ? Map.of() : stored.data(),
                        stored == null ? Map.of() : stored.provenance(),
                        binding.status().project(entity, stored, streams)));
    }

    void prepare(PublicationOutcome outcome) {
        installed = result(outcome, true, targets);
    }

    ExplainedPublication complete(PublicationOutcome outcome) {
        // All allocations for an installed result precede storage installation.
        // Rejected candidates and historical duplicate targets are deliberately discarded.
        return installed == null ? result(outcome, false, List.of()) : installed;
    }

    private static ExplainedPublication result(
            PublicationOutcome outcome,
            boolean installed,
            List<PublicationDecision.Target> targets) {
        return new ExplainedPublication(
                outcome,
                new PublicationDecision(
                        "publication-decision/v1",
                        outcome.stream(),
                        outcome.publicationSequence(),
                        outcome.status(),
                        outcome.reason(),
                        outcome.version(),
                        installed,
                        targets));
    }
}
