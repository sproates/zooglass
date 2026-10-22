package io.zooglass;

import tools.jackson.databind.JsonNode;

import java.util.Map;

public record ViewSnapshot(String viewId, String entityId, Map<String, JsonNode> data) {
}
