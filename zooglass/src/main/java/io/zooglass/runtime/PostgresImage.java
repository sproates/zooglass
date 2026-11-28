package io.zooglass.runtime;

import tools.jackson.databind.JsonNode;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;

import static io.zooglass.runtime.StateRowJson.JSON;

/** Version-one PostgreSQL representation. Composite keys are values, never JSON property names. */
record PostgresImage(long version, List<StreamRow> streams, List<ViewRow> views, Long lastWallMillis) {
    record StreamRow(Publication.StreamKey key, StateImage.StreamState state) {}
    record ViewRow(StateImage.ViewEntity key, StateImage.StoredView state) {}

    static String encode(StateImage image) {
        var streams = image.streams().entrySet().stream().map(e -> new StreamRow(e.getKey(), e.getValue())).toList();
        var views = image.views().entrySet().stream().map(e -> new ViewRow(e.getKey(), e.getValue())).toList();
        return JSON.writeValueAsString(new PostgresImage(image.version(), streams, views, image.lastWallMillis()));
    }

    static StateImage restore(String text, long revision, RuntimeConfiguration configuration) {
        var tree = JSON.readTree(text);
        require(tree.isObject() && tree.path("version").isIntegralNumber()
                && tree.path("version").canConvertToLong() && tree.path("version").longValue() == revision);
        // Jackson maps numeric property names to longs. Reject aliases such as "01" before that conversion.
        for (var row : tree.path("streams")) {
            var receipts = row.at("/state/receipts");
            require(receipts.isObject());
            for (String name : receipts.propertyNames()) {
                require(Long.toString(Long.parseLong(name)).equals(name));
            }
        }
        var saved = JSON.treeToValue(tree, PostgresImage.class);
        require(saved.lastWallMillis == null && saved.streams != null && saved.views != null);
        Map<Publication.StreamKey, StateImage.StreamState> streams = new HashMap<>();
        var versions = new HashSet<Long>();
        for (var row : saved.streams) {
            require(row != null && row.key != null && row.state != null
                    && streams.putIfAbsent(row.key, row.state) == null);
            require(row.state.progress() == null && !row.state.reservationOnly());
            for (var receipt : row.state.receipts().values()) {
                require(receipt.fact() == null && receipt.targets() != null && versions.add(receipt.version()));
                var matchingViews = configuration.views().stream()
                        .filter(view -> view.fields().values().stream().flatMap(field -> field.allInputs().stream())
                                .anyMatch(input -> input.sourceId().equals(row.key.sourceId())
                                        && input.type().equals(receipt.type())))
                        .map(RuntimeConfiguration.View::id).toList();
                require(receipt.targets().stream().map(TargetOutcome::viewId).toList().equals(matchingViews));
                require(receipt.targets().stream().allMatch(target -> target.fields() != null));
            }
        }
        require(revision == 0 ? streams.isEmpty() && saved.views.isEmpty() : versions.contains(revision));
        Map<StateImage.ViewEntity, StateImage.StoredView> views = new HashMap<>();
        for (var row : saved.views) {
            require(row != null && row.key != null && row.state != null && row.state.facts().isEmpty()
                    && views.putIfAbsent(row.key, row.state) == null);
        }
        var image = new StateImage(revision, Map.copyOf(streams), Map.copyOf(views));
        RecoveryValidation.image(image, configuration);
        // A retained accepted static field always has its source-local candidate, even when hidden.
        streams.forEach((stream, state) -> state.receipts().values().forEach(receipt -> {
            for (var target : receipt.targets()) {
                var view = views.get(new StateImage.ViewEntity(target.viewId(), target.entityId()));
                require(view != null);
                for (var field : target.fields()) {
                    var sources = view.candidates().get(field.field());
                    require(sources != null && sources.containsKey(stream.sourceId()));
                }
            }
        }));
        verifyRetainedPayloads(image, configuration);
        return image;
    }

    private static void verifyRetainedPayloads(StateImage image, RuntimeConfiguration configuration) {
        var definitions = configuration.views().stream().collect(java.util.stream.Collectors.toMap(
                RuntimeConfiguration.View::id, RuntimeConfiguration.View::fields));
        for (var row : image.views().entrySet()) {
            var fields = definitions.get(row.getKey().viewId());
            for (var field : row.getValue().candidates().entrySet()) {
                var binding = fields.get(field.getKey());
                for (var candidate : field.getValue().values()) {
                    var source = candidate.provenance();
                    var stream = image.streams().get(new Publication.StreamKey(
                            source.sourceId(), source.epoch(), source.sourceEntityId()));
                    if ("historyBySequence".equals(binding.mode())) {
                        for (var sample : candidate.value()) {
                            verifySample(sample, stream, source.sourceId(), binding);
                        }
                    } else {
                        verifySample(candidate.value(), stream, source.sourceId(), binding);
                    }
                }
            }
        }
    }

    private static void verifySample(JsonNode sample, StateImage.StreamState stream, String source,
            RuntimeConfiguration.Field field) {
        long sequence = sample.path("publicationSequence").longValue();
        if (sequence < stream.floor()) return; // The candidate can outlive its original receipt.
        var receipt = stream.receipts().get(sequence);
        require(receipt != null && field.allInputs().stream()
                .anyMatch(input -> input.sourceId().equals(source) && input.type().equals(receipt.type())));
        require(PublicationJson.content(receipt.content()).equals(PublicationJson.content(sample.path("payload"))));
    }

    private static void require(boolean condition) {
        if (!condition) throw new IllegalStateException("Invalid static PostgreSQL image");
    }
}
