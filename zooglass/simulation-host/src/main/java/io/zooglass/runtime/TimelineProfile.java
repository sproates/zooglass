package io.zooglass.runtime;

/** Explicit qualification boundary, applied after production configuration validation. */
public final class TimelineProfile {
    public static final String NAME = "memory-arrival-v1";
    public static final String MEMORY_SEQUENCE_FLEET = "memory-sequence-fleet-v1";
    public static final String SQLITE_RESTART = "receipt-age-restart-v1";

    private TimelineProfile() {}

    public static String inspect(RuntimeConfiguration config) {
        if (supportsSequenceFleet(config)) return MEMORY_SEQUENCE_FLEET;
        if (!supportsReceiptAge(config)) return "unsupported";
        return switch (config.storage()) {
            case "memory" -> NAME;
            case "sqlite" -> SQLITE_RESTART;
            default -> "unsupported";
        };
    }

    private static boolean supportsSequenceFleet(RuntimeConfiguration config) {
        if (!"memory".equals(config.storage())
                || config.sources().isEmpty()
                || config.views().isEmpty()
                || config.sources().size() > 2
                || config.views().size() > 2
                || config.maxStreams() > 20
                || config.identityWindow() > 20
                || config.maxHistoryEntries() > 20
                || config.delivery().maxQueuedMessages() > 128
                || config.delivery().maxQueuedBytes() > 1_048_576
                || config.sources().stream().anyMatch(source -> !"untracked".equals(source.progress().mode()))
                || config.views().stream().mapToInt(view -> view.fields().size()).sum() > 3)
            return false;
        return config.views().stream().allMatch(view ->
                view.fields().size() <= 2
                        && "publishPartial".equals(view.publication().mode())
                        && view.entities().values().stream()
                                .allMatch(entity -> "envelopeEntity".equals(entity.mode()))
                        && view.fields().values().stream().allMatch(TimelineProfile::sequenceField));
    }

    private static boolean sequenceField(RuntimeConfiguration.Field field) {
        return ("latestBySequence".equals(field.mode()) || "historyBySequence".equals(field.mode()))
                && field.allInputs().size() == 1
                && field.conflict() == null
                && "acceptLate".equals(field.late().mode())
                && field.facts() == null
                && field.property() == null
                && "unspecified".equals(field.freshness().mode());
    }

    private static boolean supportsReceiptAge(RuntimeConfiguration config) {
        if (config.sources().size() != 1
                || config.views().size() != 1
                || config.maxStreams() > 20
                || config.identityWindow() > 20
                || config.maxHistoryEntries() > 20)
            return false;
        var source = config.sources().getFirst();
        var view = config.views().getFirst();
        if (!"untracked".equals(source.progress().mode())
                || view.fields().size() != 1
                || !"publishPartial".equals(view.publication().mode())
                || view.entities().values().stream()
                        .anyMatch(entity -> !"envelopeEntity".equals(entity.mode())))
            return false;
        var field = view.fields().values().iterator().next();
        return "arrival".equals(field.mode())
                && field.allInputs().size() == 1
                && field.conflict() == null
                && "acceptLate".equals(field.late().mode())
                && field.facts() == null
                && field.property() == null
                && "receiptAge".equals(field.freshness().mode())
                && field.freshness().staleAfterMillis() <= 3_600_000
                && config.delivery().maxQueuedMessages() <= 128
                && config.delivery().maxQueuedBytes() <= 1_048_576;
    }
}
