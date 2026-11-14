package io.zooglass.runtime;

/** Bounded configuration combinations for the SQLite Order host foundation. */
final class OrderTimelineProfile {
    private OrderTimelineProfile() {}

    static boolean supports(RuntimeConfiguration config) {
        if (!"sqlite".equals(config.storage())
                || config.sources().isEmpty() || config.sources().size() > 5
                || config.views().isEmpty() || config.views().size() > 2
                || config.maxStreams() > 64 || config.identityWindow() > 128
                || config.maxHistoryEntries() > 64
                || config.delivery().maxQueuedMessages() > 128
                || config.delivery().maxQueuedBytes() > 1_048_576
                || config.views().stream().mapToInt(view -> view.fields().size()).sum() > 7)
            return false;
        return config.sources().stream().allMatch(source -> progress(source.progress()))
                && config.views().stream().allMatch(OrderTimelineProfile::view);
    }

    private static boolean progress(RuntimeConfiguration.Progress progress) {
        return "untracked".equals(progress.mode())
                || ("contiguousSequence".equals(progress.mode())
                        && Long.valueOf(1).equals(progress.startSequence())
                        && progress.maxReceivedRanges() <= 64
                        && progress.maxMissingRanges() <= 64);
    }

    private static boolean view(RuntimeConfiguration.View view) {
        var publication = view.publication();
        return !view.fields().isEmpty() && view.fields().size() <= 4
                && ("publishPartial".equals(publication.mode())
                        || ("requireContributions".equals(publication.mode())
                                && publication.fields().size() <= 2
                                && publication.maxPendingEntities() <= 6))
                && view.entities().values().stream().allMatch(entity ->
                        "envelopeEntity".equals(entity.mode())
                                || ("lookupEntity".equals(entity.mode()) && entity.keys().size() <= 6))
                && view.fields().values().stream().allMatch(OrderTimelineProfile::field);
    }

    private static boolean field(RuntimeConfiguration.Field field) {
        var inputs = field.allInputs();
        var conflict = field.conflict();
        boolean selection = inputs.size() == 1 ? conflict == null
                : inputs.size() == 2 && conflict != null
                        && "sourcePriority".equals(conflict.mode())
                        && conflict.sources().size() == 2
                        && inputs.stream().map(RuntimeConfiguration.Input::sourceId).distinct().count() == 2;
        return selection && "latestBySequence".equals(field.mode())
                && "acceptLate".equals(field.late().mode())
                && field.facts() == null && field.property() == null
                && ("unspecified".equals(field.freshness().mode())
                        || ("receiptAge".equals(field.freshness().mode())
                                && field.freshness().staleAfterMillis() <= 15_000));
    }
}
