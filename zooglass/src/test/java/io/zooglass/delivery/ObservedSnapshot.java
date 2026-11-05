package io.zooglass.delivery;

import tools.jackson.databind.JsonNode;

import java.util.Map;

record ObservedSnapshot(String viewId, String entityId, Map<String, JsonNode> data) {}
