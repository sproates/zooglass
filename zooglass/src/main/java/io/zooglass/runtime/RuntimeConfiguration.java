package io.zooglass.runtime;

import com.fasterxml.jackson.annotation.JsonInclude;

import io.zooglass.strategy.fact.FactRevisionSelection;
import io.zooglass.strategy.freshness.FreshnessStrategy;
import io.zooglass.strategy.freshness.FreshnessStrategySelection;
import io.zooglass.strategy.publication.PublicationStrategy;
import io.zooglass.strategy.publication.PublicationStrategySelection;

import org.springframework.core.io.ResourceLoader;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.cfg.CoercionAction;
import tools.jackson.databind.cfg.CoercionInputShape;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.type.LogicalType;

import java.io.IOException;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Startup definitions bind storage, source inputs and view-local strategies. */
public record RuntimeConfiguration(
        int contractVersion,
        String storage,
        int maxStreams,
        int identityWindow,
        int maxHistoryEntries,
        List<Source> sources,
        List<View> views) {

    public RuntimeConfiguration {
        sources = sources == null ? null : List.copyOf(sources);
        views = views == null ? null : List.copyOf(views);
    }

    public record Progress(
            String mode, Long startSequence, Long maxReceivedRanges, Long maxMissingRanges) {}

    public record Freshness(
            String mode, @JsonInclude(JsonInclude.Include.NON_NULL) Long staleAfterMillis) {
        FreshnessStrategy bind() {
            return FreshnessStrategySelection.select(mode, staleAfterMillis);
        }
    }

    public record Facts(String revision, Long maxRetainedFacts, Long minimumBirthSequence) {
        void validate() {
            FactRevisionSelection.select(revision);
            if (maxRetainedFacts == null
                    || minimumBirthSequence == null
                    || !FactEnvelope.validNumber(maxRetainedFacts)
                    || !FactEnvelope.validNumber(minimumBirthSequence)) {
                throw new IllegalArgumentException("Invalid fact bounds");
            }
        }
    }

    boolean tracksFacts() {
        return views.stream()
                .flatMap(view -> view.fields().values().stream())
                .anyMatch(field -> field.facts() != null);
    }

    boolean tracksAge() {
        return views.stream()
                .flatMap(view -> view.fields().values().stream())
                .anyMatch(field -> "receiptAge".equals(field.freshness().mode()));
    }

    public record Late(String mode) {}

    public record Source(String id, String epoch, Progress progress) {
        public Source(String id, String epoch) {
            this(id, epoch, null);
        }

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
            return PublicationStrategySelection.select(
                    mode, fields, maxPendingEntities, declaredFields);
        }
    }

    public record View(
            String id,
            Map<String, Field> fields,
            Map<String, Entity> entities,
            Exposure publication) {
        public View(String id, Map<String, Field> fields, Map<String, Entity> entities) {
            this(id, fields, entities, null);
        }

        public View(String id, Map<String, Field> fields) {
            this(id, fields, null);
        }

        public View {
            publication =
                    publication == null ? new Exposure("publishPartial", null, null) : publication;
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
                        field.allInputs()
                                .forEach(
                                        input ->
                                                settings.putIfAbsent(
                                                        input.sourceId(),
                                                        new Entity("envelopeEntity", null)));
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

    /**
     * Single inputs normalise to shorthand; multi-input order is canonical, priority order is
     * retained.
     */
    public record Field(
            String sourceId,
            String type,
            String mode,
            List<Input> inputs,
            Conflict conflict,
            Late late,
            Freshness freshness,
            @JsonInclude(JsonInclude.Include.NON_NULL) Facts facts,
            @JsonInclude(JsonInclude.Include.NON_NULL) String property) {
        public Field(
                String sourceId,
                String type,
                String mode,
                List<Input> inputs,
                Conflict conflict,
                Late late,
                Freshness freshness,
                Facts facts) {
            this(sourceId, type, mode, inputs, conflict, late, freshness, facts, null);
        }

        public Field(
                String sourceId,
                String type,
                String mode,
                List<Input> inputs,
                Conflict conflict,
                Late late,
                Freshness freshness) {
            this(sourceId, type, mode, inputs, conflict, late, freshness, null);
        }

        public Field(
                String sourceId,
                String type,
                String mode,
                List<Input> inputs,
                Conflict conflict,
                Late late) {
            this(sourceId, type, mode, inputs, conflict, late, null);
        }

        public Field(
                String sourceId, String type, String mode, List<Input> inputs, Conflict conflict) {
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
                inputs =
                        inputs.stream()
                                .sorted(
                                        Comparator.comparing(Input::sourceId)
                                                .thenComparing(Input::type))
                                .toList();
                if (inputs.size() == 1) {
                    sourceId = inputs.getFirst().sourceId();
                    type = inputs.getFirst().type();
                    inputs = null;
                }
            }
            if (conflict != null && "independentFields".equals(conflict.mode())) {
                if (conflict.sources() != null) {
                    throw new IllegalArgumentException(
                            "Independent fields do not accept source ranks");
                }
                conflict = null;
            }
        }

        public List<Input> allInputs() {
            return inputs == null ? List.of(new Input(sourceId, type)) : inputs;
        }
    }

    private static JsonMapper configurationMapper() {
        return JsonMapper.builder()
                .withCoercionConfig(
                        LogicalType.Textual,
                        coercion -> {
                            for (var shape :
                                    List.of(
                                            CoercionInputShape.Integer,
                                            CoercionInputShape.Float,
                                            CoercionInputShape.Boolean)) {
                                coercion.setCoercion(shape, CoercionAction.Fail);
                            }
                        })
                .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .build();
    }

    static RuntimeConfiguration load(ResourceLoader resources, String location) {
        var mapper = configurationMapper();
        try (var input = resources.getResource(location).getInputStream()) {
            RuntimeConfiguration config = decode(mapper, mapper.readTree(input));
            if (config == null) {
                throw new IllegalArgumentException("Missing configuration");
            }
            config.validate();
            return config;
        } catch (IOException exception) {
            throw new IllegalStateException("Cannot load configuration: " + location, exception);
        }
    }

    static RuntimeConfiguration decode(JsonMapper mapper, JsonNode document) {
        for (var view : document.path("views")) {
            validateViewDocument(view);
        }
        return mapper.treeToValue(document, RuntimeConfiguration.class);
    }

    static View parseView(String json) {
        var mapper = configurationMapper();
        var document = mapper.readTree(json);
        validateViewDocument(document);
        return mapper.treeToValue(document, View.class);
    }

    private static void validateViewDocument(JsonNode view) {
        if (view == null || !view.isObject()) {
            throw new IllegalArgumentException("View must be an object");
        }
        for (var field : view.path("fields")) {
            if (field.has("property") && !field.path("property").isTextual()) {
                throw new IllegalArgumentException("property must be a name");
            }
            if (field.has("facts") && !field.path("facts").isObject()) {
                throw new IllegalArgumentException("facts must be an object");
            }
            var freshness = field.path("freshness");
            if (!freshness.isMissingNode()
                    && (!freshness.isObject()
                            || ("unspecified".equals(freshness.path("mode").asText())
                                    && freshness.has("staleAfterMillis")))) {
                throw new IllegalArgumentException("Invalid freshness settings");
            }
        }
        if (view.path("publication").isNull()) {
            throw new IllegalArgumentException("publication must be a policy object when supplied");
        }
    }

    void validate() {
        ConfigurationValidation.validate(this);
    }
}
