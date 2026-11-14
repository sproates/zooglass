package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;

import io.zooglass.runtime.TimelineProfile;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Exercises host turns and the real runtime; only deferred task selection is modelled here. */
final class FleetTestSupport implements AutoCloseable {
    static final String CONFIGURATION = """
            {"contractVersion":2,"storage":"memory","maxStreams":20,"identityWindow":20,
             "maxHistoryEntries":20,"sources":[{"id":"position","epoch":"v1"},
               {"id":"operation","epoch":"v1"}],"views":[
               {"id":"fleet-state","fields":{
                 "position":{"sourceId":"position","type":"position","mode":"latestBySequence"},
                 "operation":{"sourceId":"operation","type":"operation","mode":"latestBySequence"}}},
               {"id":"received-journey","fields":{
                 "positions":{"sourceId":"position","type":"position","mode":"historyBySequence"}}}]}
            """;
    static final long EPOCH = 1_000_000;
    final TimelineHost host = new TimelineHost(HostProtocol.V2, false);
    private long next;
    private record Pending(JsonNode effect, long round) {}
    private final List<Pending> pending = new ArrayList<>();
    private long currentRound;

    static ObjectNode configuration() { return (ObjectNode) JSON.readTree(CONFIGURATION); }

    static ObjectNode initialization() {
        return turn("initialize-document", 0).put("startTimeMs", 0).put("epochMillis", EPOCH)
                .put("wire", CONFIGURATION).put("profile", TimelineProfile.MEMORY_SEQUENCE_FLEET);
    }

    static ObjectNode turn(String op, long id) {
        return JSON.createObjectNode().put("op", op).put("turnId", id)
                .put("runtimeGeneration", 1).put("timeMs", 0).put("monotonicMs", 0)
                .put("wallMillis", EPOCH);
    }

    JsonNode start(ObjectNode config) throws Exception {
        return call(initialization().put("wire", config.toString()));
    }

    JsonNode call(ObjectNode command) throws Exception {
        command.put("turnId", next++);
        var result = JSON.valueToTree(host.command(command));
        for (var effect : result.path("effects")) {
            if (effect.path("kind").asString().equals("schedule")) pending.add(new Pending(effect, currentRound + 1));
            if (effect.path("kind").asString().equals("cancel"))
                pending.removeIf(task -> task.effect().path("task").equals(effect.path("task")));
        }
        return result;
    }

    void connect(String session, String role) throws Exception {
        call(turn("connect", 0).put("session", session).put("role", role));
    }

    void subscribe(String session, String view) throws Exception {
        call(turn("subscribe", 0).put("session", session).put("wire",
                JSON.createObjectNode().put("action", "subscribe").put("viewId", view)
                        .put("entityId", "bus").toString()));
        drain();
    }

    JsonNode publish(String source, long sequence, String payload) throws Exception {
        var wire = JSON.createObjectNode().put("sourceId", source).put("epoch", "v1")
                .put("sourceEntityId", "bus").put("publicationSequence", sequence)
                .put("type", source);
        wire.set("payload", JSON.readTree(payload));
        return call(turn("ingress", 0).put("session", "feed").put("wire", wire.toString()));
    }

    List<JsonNode> drain() throws Exception {
        var effects = new ArrayList<JsonNode>();
        while (!pending.isEmpty()) {
            pending.sort(Comparator.comparingLong(Pending::round)
                    .thenComparingInt(task -> task.effect().path("phase").intValue())
                    .thenComparingLong(task -> task.effect().path("task").longValue()));
            var task = pending.removeFirst();
            currentRound = task.round();
            var response = call(turn("task", 0).put("task", task.effect().path("task").longValue()));
            response.path("effects").forEach(effects::add);
        }
        currentRound = 0;
        return effects;
    }

    static JsonNode wire(JsonNode effect) { return JSON.readTree(effect.path("wire").asString()); }

    static JsonNode receipt(JsonNode response) {
        for (var effect : response.path("effects"))
            if (effect.path("kind").asString().equals("receipt")) return wire(effect);
        throw new AssertionError("Missing receipt");
    }

    @Override public void close() throws Exception { call(turn("shutdown", 0)); }
}
