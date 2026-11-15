package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.HostProtocol.text;

import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.StaticViewsTimelineProfile;
import io.zooglass.runtime.StaticViewsTimelineProfile.Issue;
import io.zooglass.runtime.TimelineRuntime;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/** Pure inspection: decoded production defaults, bounded admission and an explicit comparison whitelist. */
final class RequestedProfileAdmission {
    private RequestedProfileAdmission() {}

    static Map<String, Object> inspect(JsonNode command, RuntimeConfiguration config) {
        String profile = text(command, "profile");
        var issues = StaticViewsTimelineProfile.NAME.equals(profile)
                ? StaticViewsTimelineProfile.inspect(config)
                : List.of(new Issue("$.profile", "unsupported requested profile"));
        var result = new LinkedHashMap<String, Object>();
        result.put("profile", profile);
        result.put("eligible", issues.isEmpty());
        result.put("issues", issues);
        if (command.has("referenceWire")) {
            var reference = TimelineRuntime.inspectConfiguration(text(command, "referenceWire"));
            var differences = new ArrayList<Issue>();
            compare(normalized(reference), normalized(config), "$", differences);
            result.put("comparison", Map.of("equivalent", differences.isEmpty(), "differences", differences));
        }
        return result;
    }

    private static ObjectNode normalized(RuntimeConfiguration config) {
        ObjectNode value = JSON.valueToTree(config);
        value.remove("maxStreams");
        value.remove("identityWindow");
        value.remove("maxHistoryEntries");
        var delivery = (ObjectNode) value.path("delivery");
        delivery.remove("maxQueuedMessages");
        delivery.remove("maxQueuedBytes");
        return value;
    }

    private static void compare(JsonNode reference, JsonNode supplied, String path, List<Issue> differences) {
        if (reference.equals(supplied)) return;
        if (reference.isObject() && supplied.isObject()) {
            var keys = new TreeSet<String>();
            reference.properties().forEach(entry -> keys.add(entry.getKey()));
            supplied.properties().forEach(entry -> keys.add(entry.getKey()));
            for (String key : keys)
                compare(reference.path(key), supplied.path(key), path + "[" + JSON.writeValueAsString(key) + "]", differences);
        } else if (reference.isArray() && supplied.isArray() && reference.size() == supplied.size()) {
            for (int i = 0; i < reference.size(); i++)
                compare(reference.get(i), supplied.get(i), path + "[" + i + "]", differences);
        } else {
            differences.add(new Issue(path, "differs from normalized reference configuration"));
        }
    }
}
