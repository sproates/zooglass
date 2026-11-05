package io.zooglass.runtime;

import io.zooglass.runtime.RuntimeConfiguration.Entity;
import io.zooglass.runtime.RuntimeConfiguration.Field;
import io.zooglass.runtime.RuntimeConfiguration.Input;
import io.zooglass.runtime.RuntimeConfiguration.Progress;
import io.zooglass.runtime.RuntimeConfiguration.Source;
import io.zooglass.runtime.RuntimeConfiguration.View;
import io.zooglass.strategy.contribution.ContributionStrategySelection;
import io.zooglass.strategy.identity.EntityStrategySelection;
import io.zooglass.strategy.late.LateStrategySelection;
import io.zooglass.strategy.progress.ProgressStrategySelection;

import java.util.HashSet;
import java.util.Set;

/** Checks cross-field references and strategy compatibility after configuration decoding. */
final class ConfigurationValidation {
    private static final Set<String> MODES =
            Set.of(
                    "arrival",
                    "latestBySequence",
                    "historyBySequence",
                    "activeFacts",
                    "sumActiveFacts");

    private ConfigurationValidation() {}

    static void validate(RuntimeConfiguration config) {
        int contractVersion = config.contractVersion();
        String storage = config.storage();
        int maxStreams = config.maxStreams();
        int identityWindow = config.identityWindow();
        int maxHistoryEntries = config.maxHistoryEntries();
        var sources = config.sources();
        var views = config.views();
        if (contractVersion != 2 || !("memory".equals(storage) || "sqlite".equals(storage))) {
            throw new IllegalArgumentException(
                    "Runtime requires contractVersion 2 and storage memory or sqlite");
        }
        if (maxStreams < 1
                || identityWindow < 1
                || maxHistoryEntries < 1
                || sources == null
                || views == null) {
            throw new IllegalArgumentException(
                    "Runtime requires positive limits and source/view lists");
        }

        Set<String> sourceIds = new HashSet<>();
        for (Source source : sources) {
            if (source == null
                    || !name(source.id())
                    || !name(source.epoch())
                    || !sourceIds.add(source.id())) {
                throw new IllegalArgumentException("Invalid or duplicate source");
            }
        }

        var progressBySource = new java.util.HashMap<String, Progress>();
        for (Source source : sources) {
            Progress progress = source.progress();
            ProgressStrategySelection.select(
                    progress.mode(),
                    progress.startSequence(),
                    progress.maxReceivedRanges(),
                    progress.maxMissingRanges());
            progressBySource.put(source.id(), progress);
        }

        Set<String> viewIds = new HashSet<>();
        for (View view : views) {
            if (view == null
                    || !name(view.id())
                    || !viewIds.add(view.id())
                    || view.fields() == null
                    || view.fields().isEmpty()) {
                throw new IllegalArgumentException("Invalid or duplicate view");
            }
            view.publication().bind(view.fields().keySet());
            var usedSources = new HashSet<String>();
            for (var entry : view.fields().entrySet()) {
                usedSources.addAll(
                        validateField(
                                entry.getKey(), entry.getValue(), sourceIds, progressBySource));
            }
            for (var entry : view.entities().entrySet()) {
                Entity entity = entry.getValue();
                if (!usedSources.contains(entry.getKey()) || entity == null) {
                    throw new IllegalArgumentException(
                            "Entity resolver must reference a source used by its view");
                }
                EntityStrategySelection.select(entity.mode(), entity.keys());
            }
        }
    }

    private static Set<String> validateField(
            String fieldName,
            Field field,
            Set<String> sourceIds,
            java.util.Map<String, Progress> progressBySource) {
        if (!name(fieldName)
                || field == null
                || field.mode() == null
                || !MODES.contains(field.mode())) {
            throw new IllegalArgumentException("Invalid field");
        }
        var inputSources = new HashSet<String>();
        var matchers = new HashSet<Input>();
        for (Input input : field.allInputs()) {
            if (!sourceIds.contains(input.sourceId())
                    || !name(input.type())
                    || !matchers.add(input)) {
                throw new IllegalArgumentException("Invalid or duplicate field input");
            }
            inputSources.add(input.sourceId());
        }
        var conflict = field.conflict();
        ContributionStrategySelection.select(
                conflict == null ? "independentFields" : conflict.mode(),
                conflict == null ? null : conflict.sources(),
                inputSources);
        if (conflict != null && !"latestBySequence".equals(field.mode())) {
            throw new IllegalArgumentException("Source priority requires latestBySequence");
        }
        if ("activeFacts".equals(field.mode()) || "sumActiveFacts".equals(field.mode())) {
            if (field.facts() == null || field.allInputs().size() != 1 || conflict != null) {
                throw new IllegalArgumentException(
                        "Fact collections require one input and fact settings");
            }
            field.facts().validate();
            io.zooglass.strategy.fact.FactProjectionSelection.select(
                    field.mode(), field.property());
        } else if (field.facts() != null || field.property() != null) {
            throw new IllegalArgumentException("Fact settings require a fact projection");
        }
        field.freshness().bind();
        LateStrategySelection.select(field.late().mode());
        if ("rejectBehindWatermark".equals(field.late().mode())
                && inputSources.stream()
                        .anyMatch(
                                source ->
                                        !"contiguousSequence"
                                                .equals(progressBySource.get(source).mode()))) {
            throw new IllegalArgumentException(
                    "Reject-behind-watermark requires contiguous inputs");
        }
        return inputSources;
    }

    private static boolean name(String value) {
        return value != null && !value.isBlank();
    }
}
