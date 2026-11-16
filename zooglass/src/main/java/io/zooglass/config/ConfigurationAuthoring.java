package io.zooglass.config;

import io.zooglass.runtime.ConfigurationInspection;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Resolves only local field references; production validation owns runtime semantics. */
final class ConfigurationAuthoring {
    static final String FORMAT = "zooglass-config/v1";
    private static final Set<String> ROOT = Set.of(
            "format", "fieldTemplates", "storage", "maxStreams", "identityWindow",
            "maxHistoryEntries", "sources", "views", "delivery");
    private static final Set<String> SETTINGS = Set.of(
            "sourceId", "type", "inputs", "conflict", "late", "freshness", "facts");
    private static final Set<String> USE = Set.of("use", "mode", "property");
    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    record Origin(String path, String usePath, String templatePath, List<String> settings) {}
    record Resolved(JsonNode root, Map<String, JsonNode> fields, List<Origin> origins) {}

    static final class Invalid extends IllegalArgumentException {
        final String path;

        Invalid(String path, String reason) {
            super(reason);
            this.path = path;
        }
    }

    private ConfigurationAuthoring() {}

    static Resolved resolve(JsonNode source) {
        require(source.isObject(), "", "Authoring input must be an object");
        keys(source, ROOT, "");
        require(FORMAT.equals(source.path("format").asText()), "/format", "Unsupported authoring format");
        var templates = source.path("fieldTemplates");
        require(templates.isObject() && !templates.isEmpty(), "/fieldTemplates", "Declare at least one local field template");
        var used = new java.util.HashSet<String>();
        for (var entry : templates.properties()) {
            String path = "/fieldTemplates/" + token(entry.getKey());
            require(!entry.getKey().isBlank(), path, "Template names must not be blank");
            require(entry.getValue().isObject(), path, "Template settings must be an object");
            keys(entry.getValue(), SETTINGS, path);
        }
        var fields = new LinkedHashMap<String, JsonNode>();
        var origins = new ArrayList<Origin>();
        var views = source.path("views");
        require(views.isArray(), "/views", "Views must be an array");
        for (int index = 0; index < views.size(); index++) {
            String viewPath = "/views/" + index;
            var declaredFields = views.path(index).path("fields");
            require(declaredFields.isObject(), viewPath + "/fields", "View fields must be an object");
            for (var entry : declaredFields.properties()) {
                var field = entry.getValue();
                if (!field.has("use")) continue;
                String path = viewPath + "/fields/" + token(entry.getKey());
                keys(field, USE, path);
                require(field.path("use").isTextual(), path + "/use", "Use must name a local template");
                String name = field.path("use").asText();
                require(templates.has(name), path + "/use", "Unknown local template");
                require(field.path("mode").isTextual() && !field.path("mode").asText().isBlank(),
                        path + "/mode", "Each use must declare its update mode");
                if (field.has("property")) {
                    require(field.path("property").isTextual(), path + "/property", "Property must be a name");
                }
                // Shallow copies retain immutable input subtrees. Substituted bytes are bounded
                // before a complete expanded tree is parsed; repeated settings are not deep-copied.
                ObjectNode replacement = MAPPER.createObjectNode();
                templates.path(name).properties().forEach(setting -> replacement.set(setting.getKey(), setting.getValue()));
                replacement.set("mode", field.path("mode"));
                if (field.has("property")) replacement.set("property", field.path("property"));
                fields.put(path, replacement);
                origins.add(new Origin(path, path + "/use", "/fieldTemplates/" + token(name),
                        templates.path(name).propertyNames().stream().sorted().toList()));
                used.add(name);
            }
        }
        for (String name : templates.propertyNames()) {
            require(used.contains(name), "/fieldTemplates/" + token(name), "Every declared template must be used");
        }
        ObjectNode root = MAPPER.createObjectNode();
        source.properties().stream()
                .filter(entry -> !Set.of("format", "fieldTemplates").contains(entry.getKey()))
                .forEach(entry -> root.set(entry.getKey(), entry.getValue()));
        root.put("contractVersion", 2);
        return new Resolved(root, Map.copyOf(fields), List.copyOf(origins));
    }

    private static void keys(JsonNode object, Set<String> allowed, String path) {
        for (String key : object.propertyNames()) {
            require(allowed.contains(key), path + "/" + token(key), "Setting is not allowed here");
        }
    }

    private static void require(boolean condition, String path, String reason) {
        if (!condition) throw new Invalid(path, reason);
    }

    private static String token(String name) {
        return ConfigurationInspection.pointerToken(name);
    }
}
