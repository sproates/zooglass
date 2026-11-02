package io.zooglass.v2;

import tools.jackson.databind.JsonNode;

import java.util.Map;

/** Detached state prepared by the coordinator; installation transfers ownership to storage. */
record StateImage(long version, Map<Publication.StreamKey, StreamState> streams,
        Map<ViewEntity, StoredView> views) {
    static StateImage empty() {
        return new StateImage(0, Map.of(), Map.of());
    }

    record ViewEntity(String viewId, String entityId) {}
    record StoredView(long version, Map<String, JsonNode> data) {}
    record Receipt(String type, JsonNode content, long version) {}
    record StreamState(long floor, Map<Long, Receipt> receipts) {}
}
