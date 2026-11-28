package io.zooglass.runtime;

import io.zooglass.access.ViewResource;
import java.util.Set;

record HaCommand(boolean subscribe, long id, ViewResource resource) {
    static HaCommand parse(String text) {
        var node = StateRowJson.JSON.readTree(text);
        var required = Set.of("action", "subscription", "viewId", "entityId");
        if (node == null || !node.isObject() || required.stream().anyMatch(key -> !node.path(key).isTextual())) {
            throw new IllegalArgumentException("Invalid viewer command");
        }
        String action = node.path("action").asText();
        boolean subscribe = "subscribe".equals(action);
        if ((!subscribe && !"unsubscribe".equals(action)) || !(node.size() == 4 || (subscribe && node.size() == 5
                && node.path("recovery").isTextual() && "freshSnapshot".equals(node.path("recovery").asText())))) {
            throw new IllegalArgumentException("Invalid viewer command");
        }
        var id = node.path("subscription").asText();
        if (!id.matches("[1-9][0-9]{0,18}")) throw new IllegalArgumentException("Invalid subscription");
        return new HaCommand(subscribe, Long.parseLong(id), new ViewResource(node.path("viewId").asText(), node.path("entityId").asText()));
    }
    String subscription() { return Long.toString(id); }
}
