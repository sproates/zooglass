package io.zooglass.runtime;

import java.util.Set;

/** Production semantic coverage; timeline resource and action limits belong to the host. */
final class PublicationExplanationSupport {
    private static final Set<String> MODES =
            Set.of("arrival", "latestBySequence", "historyBySequence");

    private PublicationExplanationSupport() {}

    static void requireSupported(RuntimeConfiguration configuration) {
        boolean supported =
                configuration.sources().stream()
                                .allMatch(source -> source.progress().mode().equals("untracked"))
                        && configuration.views().stream()
                                .allMatch(PublicationExplanationSupport::supportsView);
        if (!supported) {
            throw new IllegalArgumentException(
                    "Publication explanations require static independent fields with envelope"
                            + " entities, partial publication, untracked progress and unspecified"
                            + " freshness");
        }
    }

    private static boolean supportsView(RuntimeConfiguration.View view) {
        return view.publication().mode().equals("publishPartial")
                && view.entities().values().stream()
                        .allMatch(entity -> entity.mode().equals("envelopeEntity"))
                && view.fields().values().stream()
                        .allMatch(PublicationExplanationSupport::supportsField);
    }

    private static boolean supportsField(RuntimeConfiguration.Field field) {
        return field.facts() == null
                && MODES.contains(field.mode())
                && field.freshness().mode().equals("unspecified")
                && field.late().mode().equals("acceptLate")
                && (field.conflict() == null || field.conflict().mode().equals("independentFields"))
                && field.allInputs().stream()
                                .map(RuntimeConfiguration.Input::sourceId)
                                .distinct()
                                .count()
                        == 1;
    }
}
