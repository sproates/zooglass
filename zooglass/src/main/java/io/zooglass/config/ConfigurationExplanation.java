package io.zooglass.config;

import io.zooglass.runtime.ConfigurationInspection;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;

/** Presents production-decoded settings and marks only actual default applications. */
final class ConfigurationExplanation {
    private static final JsonMapper MAPPER = JsonMapper.builder().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS).build();

    record DefaultValue(String path, JsonNode value) {}
    record Explanation(JsonNode effective, List<DefaultValue> defaults) {}

    private ConfigurationExplanation() {}

    static Explanation explain(ConfigurationInspection.Result inspection) {
        ObjectNode effective = MAPPER.valueToTree(inspection.configuration());
        var declared = inspection.declared();
        var defaults = new ArrayList<DefaultValue>();
        for (String name : List.of("recovery", "slowClient", "maxQueuedMessages", "maxQueuedBytes")) {
            addDefault(defaults, declared, effective, "/delivery/" + name);
        }
        for (int i = 0; i < effective.path("sources").size(); i++) {
            addDefault(defaults, declared, effective, "/sources/" + i + "/progress");
        }
        for (int i = 0; i < effective.path("views").size(); i++) {
            String viewPath = "/views/" + i;
            addDefault(defaults, declared, effective, viewPath + "/publication");
            var view = effective.at(viewPath);
            view.path("entities").propertyNames().stream().sorted().forEach(source ->
                    addDefault(defaults, declared, effective,
                            viewPath + "/entities/" + ConfigurationInspection.pointerToken(source)));
            for (var entry : view.path("fields").properties()) {
                String fieldPath = viewPath + "/fields/" + ConfigurationInspection.pointerToken(entry.getKey());
                var field = (ObjectNode) entry.getValue();
                // Null is the runtime's compact representation of independentFields.
                // The explanation names the effective policy instead of exposing that shorthand.
                if (field.path("conflict").isNull()) {
                    field.set("conflict", MAPPER.createObjectNode().put("mode", "independentFields"));
                }
                for (String name : List.of("conflict", "late", "freshness")) {
                    addDefault(defaults, declared, effective, fieldPath + "/" + name);
                }
            }
        }
        return new Explanation(effective, List.copyOf(defaults));
    }

    private static void addDefault(
            List<DefaultValue> defaults, JsonNode declared, JsonNode effective, String path) {
        var value = declared.at(path);
        if (value.isMissingNode() || value.isNull()) {
            defaults.add(new DefaultValue(path, effective.at(path)));
        }
    }
}
