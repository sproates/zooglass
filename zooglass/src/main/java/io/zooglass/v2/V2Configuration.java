package io.zooglass.v2;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.zooglass.strategy.freshness.FreshnessStrategy;
import io.zooglass.strategy.freshness.FreshnessStrategySelection;
import io.zooglass.strategy.publication.PublicationStrategy;

import io.zooglass.strategy.publication.PublicationStrategySelection;

import io.zooglass.strategy.progress.ProgressStrategySelection;
import io.zooglass.strategy.late.LateStrategySelection;

import org.springframework.core.io.ResourceLoader;
import io.zooglass.strategy.identity.EntityStrategySelection;
import io.zooglass.strategy.contribution.ContributionStrategySelection;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.type.LogicalType;
import tools.jackson.databind.cfg.CoercionInputShape;
import tools.jackson.databind.cfg.CoercionAction;

import java.util.HashSet;
import java.util.Collections;
import java.util.TreeMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** V2 startup definitions bind storage, source inputs and view-local strategies. */
public record V2Configuration(int contractVersion, String storage, int maxStreams,
        int identityWindow, int maxHistoryEntries, List<Source> sources, List<View> views) {
    private static final Set<String> MODES = Set.of("arrival", "latestBySequence", "historyBySequence");

    public record Progress(String mode, Long startSequence, Long maxReceivedRanges, Long maxMissingRanges) {}
    public record Freshness(String mode, @JsonInclude(JsonInclude.Include.NON_NULL) Long staleAfterMillis) {
        FreshnessStrategy bind() {
            return FreshnessStrategySelection.select(mode, staleAfterMillis);
        }
    }

    boolean tracksAge() {
        return views.stream().flatMap(view -> view.fields().values().stream())
                .anyMatch(field -> "receiptAge".equals(field.freshness().mode()));
    }

    public record Late(String mode) {}
    public record Source(String id, String epoch, Progress progress) {
        public Source(String id, String epoch) { this(id, epoch, null); }
        public Source {
            progress = progress == null ? new Progress("untracked", null, null, null) : progress;
        }
    }
    public record Entity(String mode, Map<String, String> keys) {
        public Entity {
            keys = keys == null ? null : Map.copyOf(keys);
        }
    }

    public record Exposure(String mode, List<String> fields, Long maxPendingEntities) {
        public Exposure {
            fields = fields == null ? null : fields.stream().sorted().toList();
        }

        PublicationStrategy bind(Set<String> declaredFields) {
            return PublicationStrategySelection.select(mode, fields, maxPendingEntities, declaredFields);
        }
    }

    public record View(String id, Map<String, Field> fields, Map<String, Entity> entities,
            Exposure publication) {
        public View(String id, Map<String, Field> fields, Map<String, Entity> entities) {
            this(id, fields, entities, null);
        }

        public View(String id, Map<String, Field> fields) {
            this(id, fields, null);
        }

        public View {
            publication = publication == null ? new Exposure("publishPartial", null, null) : publication;
            if (fields != null) {
                fields = Collections.unmodifiableMap(new TreeMap<>(fields));
            }
            var settings = new TreeMap<String, Entity>();
            if (entities != null) {
                settings.putAll(Map.copyOf(entities));
            }
            if (fields != null) {
                for (Field field : fields.values()) {
                    if (field != null) {
                        field.allInputs().forEach(input -> settings.putIfAbsent(
                                input.sourceId(), new Entity("envelopeEntity", null)));
                    }
                }
            }
            entities = Map.copyOf(settings);
        }
    }

    public record Input(String sourceId, String type) {}
    public record Conflict(String mode, List<String> sources) {
        public Conflict {
            sources = sources == null ? null : List.copyOf(sources);
        }
    }

    /** Single inputs normalise to shorthand; multi-input order is canonical, priority order is retained. */
    public record Field(String sourceId, String type, String mode, List<Input> inputs, Conflict conflict, Late late,
            Freshness freshness) {
        public Field(String sourceId, String type, String mode, List<Input> inputs, Conflict conflict, Late late) {
            this(sourceId, type, mode, inputs, conflict, late, null);
        }
        public Field(String sourceId, String type, String mode, List<Input> inputs, Conflict conflict) {
            this(sourceId, type, mode, inputs, conflict, null);
        }
        public Field(String sourceId, String type, String mode) {
            this(sourceId, type, mode, null, null);
        }

        public Field {
            freshness = freshness == null ? new Freshness("unspecified", null) : freshness;
            late = late == null ? new Late("acceptLate") : late;
            if (inputs != null) {
                if (sourceId != null || type != null || inputs.isEmpty()) {
                    throw new IllegalArgumentException("Use either shorthand or nonempty inputs");
                }
                inputs = inputs.stream().sorted(java.util.Comparator.comparing(Input::sourceId)).toList();
                if (inputs.size() == 1) {
                    sourceId = inputs.getFirst().sourceId();
                    type = inputs.getFirst().type();
                    inputs = null;
                }
            }
            if (conflict != null && "independentFields".equals(conflict.mode())) {
                if (conflict.sources() != null) {
                    throw new IllegalArgumentException("Independent fields do not accept source ranks");
                }
                conflict = null;
            }
        }

        public List<Input> allInputs() {
            return inputs == null ? List.of(new Input(sourceId, type)) : inputs;
        }
    }

    static V2Configuration load(ResourceLoader resources, String location) {
        var mapper = JsonMapper.builder()
                .withCoercionConfig(LogicalType.Textual, coercion -> {
                    for (var shape : List.of(CoercionInputShape.Integer,
                            CoercionInputShape.Float,
                            CoercionInputShape.Boolean)) {
                        coercion.setCoercion(shape, CoercionAction.Fail);
                    }
                })
                .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        try (var input = resources.getResource(location).getInputStream()) {
            V2Configuration config = decode(mapper, mapper.readTree(input));
            if (config == null) {
                throw new IllegalArgumentException("Missing v2 configuration");
            }
            config.validate();
            return config;
        } catch (java.io.IOException exception) {
            throw new IllegalStateException("Cannot load v2 configuration: " + location, exception);
        }
    }

    static V2Configuration decode(JsonMapper mapper, tools.jackson.databind.JsonNode document) {
        for (var view : document.path("views")) {
            for (var field : view.path("fields")) {
                var freshness = field.path("freshness");
                if (!freshness.isMissingNode() && (!freshness.isObject()
                        || ("unspecified".equals(freshness.path("mode").asText()) && freshness.has("staleAfterMillis")))) {
                    throw new IllegalArgumentException("Invalid freshness settings");
                }
            }
            if (view.path("publication").isNull()) {
                throw new IllegalArgumentException("publication must be a policy object when supplied");
            }
        }
        return mapper.treeToValue(document, V2Configuration.class);
    }

    void validate() {
        if (contractVersion != 2 || !("memory".equals(storage) || "sqlite".equals(storage))) {
            throw new IllegalArgumentException("V2 requires contractVersion 2 and storage memory or sqlite");
        }
        if (maxStreams < 1 || identityWindow < 1 || maxHistoryEntries < 1 || sources == null || views == null) {
            throw new IllegalArgumentException("V2 requires positive limits and source/view lists");
        }

        Set<String> sourceIds = new HashSet<>();
        for (Source source : sources) {
            if (source == null || !name(source.id()) || !name(source.epoch()) || !sourceIds.add(source.id())) {
                throw new IllegalArgumentException("Invalid or duplicate v2 source");
            }
        }

        var progressBySource = new java.util.HashMap<String, Progress>();
        for (Source source : sources) {
            Progress progress = source.progress();
            ProgressStrategySelection.select(progress.mode(), progress.startSequence(),
                    progress.maxReceivedRanges(), progress.maxMissingRanges());
            progressBySource.put(source.id(), progress);
        }

        Set<String> viewIds = new HashSet<>();
        for (View view : views) {
            if (view == null || !name(view.id()) || !viewIds.add(view.id())
                    || view.fields() == null || view.fields().isEmpty()) {
                throw new IllegalArgumentException("Invalid or duplicate v2 view");
            }
            view.publication().bind(view.fields().keySet());
            var usedSources = new HashSet<String>();
            for (var entry : view.fields().entrySet()) {
                Field field = entry.getValue();
                if (!name(entry.getKey()) || field == null
                        || field.mode() == null || !MODES.contains(field.mode())) {
                    throw new IllegalArgumentException("Invalid v2 field");
                }
                var inputSources = new HashSet<String>();
                for (Input input : field.allInputs()) {
                    if (!sourceIds.contains(input.sourceId()) || !name(input.type())
                            || !inputSources.add(input.sourceId())) {
                        throw new IllegalArgumentException("Invalid or duplicate field input");
                    }
                }
                var conflict = field.conflict();
                ContributionStrategySelection.select(
                        conflict == null ? "independentFields" : conflict.mode(),
                        conflict == null ? null : conflict.sources(), inputSources);
                if (conflict != null && !"latestBySequence".equals(field.mode())) {
                    throw new IllegalArgumentException("Source priority requires latestBySequence");
                }
                field.freshness().bind();
                LateStrategySelection.select(field.late().mode());
                if ("rejectBehindWatermark".equals(field.late().mode()) && inputSources.stream()
                        .anyMatch(source -> !"contiguousSequence".equals(progressBySource.get(source).mode()))) {
                    throw new IllegalArgumentException("Reject-behind-watermark requires contiguous inputs");
                }
                usedSources.addAll(inputSources);
            }
            for (var entry : view.entities().entrySet()) {
                Entity entity = entry.getValue();
                if (!usedSources.contains(entry.getKey()) || entity == null) {
                    throw new IllegalArgumentException("Entity resolver must reference a source used by its view");
                }
                EntityStrategySelection.select(entity.mode(), entity.keys());
            }
        }
    }

    private static boolean name(String value) {
        return value != null && !value.isBlank();
    }
}
