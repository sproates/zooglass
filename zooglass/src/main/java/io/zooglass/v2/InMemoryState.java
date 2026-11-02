package io.zooglass.v2;

import tools.jackson.databind.JsonNode;
import java.util.Map;

/** Owns the complete memory image. Only the coordinator reads or replaces it under its lock. */
final class InMemoryState {
    private Image current = new Image(0, Map.of(), Map.of());

    Image current() {
        return current;
    }

    void install(Image next) {
        current = next;
    }

    record ViewEntity(String viewId, String entityId) {}
    record StoredView(long version, Map<String, JsonNode> data) {}
    record Receipt(String type, Object content, long version) {}
    record StreamState(long floor, Map<Long, Receipt> receipts) {}
    record Image(long version, Map<Publication.StreamKey, StreamState> streams,
            Map<ViewEntity, StoredView> views) {}
}
