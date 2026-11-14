package io.zooglass.runtime;

/** Bounded fact/retirement combinations for ordinary SQLite Sports execution. */
final class SportsTimelineProfile {
    private SportsTimelineProfile() {}

    static boolean supports(RuntimeConfiguration config) {
        if (!"sqlite".equals(config.storage())
                || config.sources().isEmpty() || config.sources().size() > 2
                || config.views().isEmpty() || config.views().size() > 3
                || config.maxStreams() > 16 || config.identityWindow() > 128
                || config.maxHistoryEntries() > 64
                || config.delivery().maxQueuedMessages() > 128
                || config.delivery().maxQueuedBytes() > 1_048_576
                || config.views().stream().mapToInt(view -> view.fields().size()).sum() > 14)
            return false;
        return config.sources().stream().allMatch(source -> progress(source.progress()))
                && config.views().stream().allMatch(SportsTimelineProfile::view)
                && config.views().stream().flatMap(view -> view.fields().values().stream())
                        .anyMatch(field -> field.facts() != null);
    }

    private static boolean progress(RuntimeConfiguration.Progress progress) {
        return "contiguousSequence".equals(progress.mode())
                && Long.valueOf(1).equals(progress.startSequence())
                && progress.maxReceivedRanges() <= 16 && progress.maxMissingRanges() <= 16;
    }

    private static boolean view(RuntimeConfiguration.View view) {
        return !view.fields().isEmpty() && view.fields().size() <= 6
                && "publishPartial".equals(view.publication().mode())
                && view.entities().values().stream().allMatch(entity -> "envelopeEntity".equals(entity.mode()))
                && view.fields().values().stream().allMatch(SportsTimelineProfile::field);
    }

    private static boolean field(RuntimeConfiguration.Field field) {
        if (field.allInputs().size() != 1 || field.conflict() != null
                || !"acceptLate".equals(field.late().mode())) return false;
        if ("latestBySequence".equals(field.mode()))
            return field.facts() == null && field.property() == null
                    && ("unspecified".equals(field.freshness().mode())
                            || ("receiptAge".equals(field.freshness().mode())
                                    && field.freshness().staleAfterMillis() <= 15_000));
        var facts = field.facts();
        return facts != null && facts.maxRetainedFacts() <= 16
                && Long.valueOf(1).equals(facts.minimumBirthSequence())
                && ("firstFact".equals(facts.revision()) || "latestFactRevision".equals(facts.revision()))
                && "unspecified".equals(field.freshness().mode())
                && (("activeFacts".equals(field.mode()) && field.property() == null)
                        || ("sumActiveFacts".equals(field.mode()) && "points".equals(field.property())));
    }
}
