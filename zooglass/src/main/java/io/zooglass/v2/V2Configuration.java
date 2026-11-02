package io.zooglass.v2;

import org.springframework.core.io.ResourceLoader;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.json.JsonMapper;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** V2 startup definitions bind storage and independent single-source fields. */
public record V2Configuration(int contractVersion, String storage, int maxStreams,
        int identityWindow, int maxHistoryEntries, List<Source> sources, List<View> views) {
    private static final Set<String> MODES = Set.of("arrival", "latestBySequence", "historyBySequence");

    public record Source(String id, String epoch) {}
    public record View(String id, Map<String, Field> fields) {}
    public record Field(String sourceId, String type, String mode) {}

    static V2Configuration load(ResourceLoader resources, String location) {
        var mapper = JsonMapper.builder()
                .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
                .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        try (var input = resources.getResource(location).getInputStream()) {
            V2Configuration config = mapper.readValue(input, V2Configuration.class);
            if (config == null) {
                throw new IllegalArgumentException("Missing v2 configuration");
            }
            config.validate();
            return config;
        } catch (java.io.IOException exception) {
            throw new IllegalStateException("Cannot load v2 configuration: " + location, exception);
        }
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

        Set<String> viewIds = new HashSet<>();
        for (View view : views) {
            if (view == null || !name(view.id()) || !viewIds.add(view.id())
                    || view.fields() == null || view.fields().isEmpty()) {
                throw new IllegalArgumentException("Invalid or duplicate v2 view");
            }
            for (var entry : view.fields().entrySet()) {
                Field field = entry.getValue();
                if (!name(entry.getKey()) || field == null || !sourceIds.contains(field.sourceId())
                        || !name(field.type()) || field.mode() == null || !MODES.contains(field.mode())) {
                    throw new IllegalArgumentException("Invalid v2 field or source reference");
                }
            }
        }
    }

    private static boolean name(String value) {
        return value != null && !value.isBlank();
    }
}
