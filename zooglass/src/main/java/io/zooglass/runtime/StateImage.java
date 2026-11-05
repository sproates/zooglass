package io.zooglass.runtime;

import io.zooglass.strategy.contribution.SelectedContribution;
import io.zooglass.strategy.progress.ProgressState;

import tools.jackson.databind.JsonNode;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Detached state prepared by the coordinator; installation transfers ownership to storage. */
record StateImage(
        long version,
        Map<Publication.StreamKey, StreamState> streams,
        Map<ViewEntity, StoredView> views,
        Long lastWallMillis) {
    StateImage(
            long version,
            Map<Publication.StreamKey, StreamState> streams,
            Map<ViewEntity, StoredView> views) {
        this(version, streams, views, null);
    }

    static StateImage empty() {
        return new StateImage(0, Map.of(), Map.of());
    }

    record ViewEntity(String viewId, String entityId) {}

    record StoredView(
            long version,
            Map<String, JsonNode> data,
            Map<String, Provenance> provenance,
            Map<String, Map<String, SelectedContribution>> candidates,
            @com.fasterxml.jackson.annotation.JsonInclude(
                            com.fasterxml.jackson.annotation.JsonInclude.Include.NON_EMPTY)
                    Map<String, FactState> facts) {
        StoredView(
                long version,
                Map<String, JsonNode> data,
                Map<String, Provenance> provenance,
                Map<String, Map<String, SelectedContribution>> candidates) {
            this(version, data, provenance, candidates, Map.of());
        }

        StoredView(long version, Map<String, JsonNode> data, Map<String, Provenance> provenance) {
            this(version, data, provenance, null);
        }

        StoredView replaceCandidate(
                String field, String source, SelectedContribution replacement, long nextVersion) {
            var updated = new HashMap<>(candidates);
            var sources = new HashMap<>(updated.get(field));
            sources.put(source, replacement);
            updated.put(field, sources);
            return new StoredView(nextVersion, data, provenance, updated, facts);
        }

        boolean pending() {
            return (!candidates.isEmpty() || !facts.isEmpty()) && data.isEmpty();
        }

        StoredView {
            facts = facts == null ? Map.of() : Map.copyOf(facts);
            if (candidates != null) {
                var copy = new HashMap<String, Map<String, SelectedContribution>>();
                candidates.forEach((field, values) -> copy.put(field, Map.copyOf(values)));
                candidates = Map.copyOf(copy);
            }
            data = data == null ? null : Map.copyOf(data);
            provenance = provenance == null ? null : Map.copyOf(provenance);
        }
    }

    record Receipt(
            String type,
            JsonNode content,
            long version,
            List<TargetOutcome> targets,
            @com.fasterxml.jackson.annotation.JsonInclude(
                            com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                    FactEnvelope fact) {
        Receipt(String type, JsonNode content, long version, List<TargetOutcome> targets) {
            this(type, content, version, targets, null);
        }

        Receipt {
            targets = targets == null ? null : List.copyOf(targets);
        }
    }

    record StreamState(
            long floor,
            Map<Long, Receipt> receipts,
            ProgressState progress,
            @com.fasterxml.jackson.annotation.JsonInclude(
                            com.fasterxml.jackson.annotation.JsonInclude.Include.NON_DEFAULT)
                    Boolean reservationOnly) {
        StreamState(long floor, Map<Long, Receipt> receipts, ProgressState progress) {
            this(floor, receipts, progress, false);
        }

        StreamState(long floor, Map<Long, Receipt> receipts) {
            this(floor, receipts, null);
        }

        StreamState {
            receipts = Map.copyOf(receipts);
            reservationOnly = Boolean.TRUE.equals(reservationOnly);
        }
    }
}
