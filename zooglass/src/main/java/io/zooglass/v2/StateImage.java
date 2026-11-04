package io.zooglass.v2;

import tools.jackson.databind.JsonNode;

import java.util.Map;
import java.util.List;

/** Detached state prepared by the coordinator; installation transfers ownership to storage. */
record StateImage(long version, Map<Publication.StreamKey, StreamState> streams,
        Map<ViewEntity, StoredView> views) {
    static StateImage empty() {
        return new StateImage(0, Map.of(), Map.of());
    }

    record ViewEntity(String viewId, String entityId) {}
    record StoredView(long version, Map<String, JsonNode> data, Map<String, Provenance> provenance) {
        StoredView {
            data = data == null ? null : Map.copyOf(data);
            provenance = provenance == null ? null : Map.copyOf(provenance);
        }
    }

    record Receipt(String type, JsonNode content, long version, List<TargetOutcome> targets) {
        Receipt {
            targets = targets == null ? null : List.copyOf(targets);
        }
    }

    record StreamState(long floor, Map<Long, Receipt> receipts) {}
}
