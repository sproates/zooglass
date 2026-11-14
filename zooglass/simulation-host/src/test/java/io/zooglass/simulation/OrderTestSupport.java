package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;

import io.zooglass.runtime.TimelineProfile;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Real host/runtime fixture. The queue chooses only explicitly scheduled host tasks. */
final class OrderTestSupport implements AutoCloseable {
    static final long EPOCH = 1_000_000;
    final TimelineHost host = new TimelineHost(HostProtocol.V2, true);
    private long next;
    private long time;
    private long round;
    private record Pending(JsonNode effect, long round) {}
    private final List<Pending> pending = new ArrayList<>();

    static ObjectNode configuration() throws Exception {
        try (var input = OrderTestSupport.class.getResourceAsStream("/order-runtime.json")) {
            return (ObjectNode) JSON.readTree(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    static ObjectNode turn(String operation, long time) {
        return JSON.createObjectNode().put("op", operation).put("turnId", 0)
                .put("runtimeGeneration", 1).put("timeMs", time).put("monotonicMs", time)
                .put("wallMillis", EPOCH + time);
    }

    static ObjectNode initialization(Path database) throws Exception {
        return turn("initialize-document", 0).put("startTimeMs", 0).put("epochMillis", EPOCH)
                .put("database", database.toString()).put("profile", TimelineProfile.SQLITE_ORDER)
                .put("wire", configuration().toString());
    }

    void start(Path database) throws Exception { call(initialization(database)); }

    JsonNode call(ObjectNode command) throws Exception {
        command.put("turnId", next++);
        time = command.path("timeMs").longValue();
        var result = JSON.valueToTree(host.command(command));
        for (var effect : result.path("effects")) {
            if (effect.path("kind").asString().equals("schedule"))
                pending.add(new Pending(effect, effect.path("at").longValue() == time ? round + 1 : 0));
            if (effect.path("kind").asString().equals("cancel"))
                pending.removeIf(task -> task.effect().path("task").equals(effect.path("task")));
        }
        return result;
    }

    void connect(String id, String role) throws Exception {
        call(turn("connect", time).put("session", id).put("role", role));
    }

    JsonNode publish(long at, String source, String entity, String type, long sequence) throws Exception {
        String body = JSON.createObjectNode().put("sourceId", source).put("epoch", "run")
                .put("sourceEntityId", entity).put("publicationSequence", sequence).put("type", type)
                .set("payload", JSON.createObjectNode().put("status", "value-" + sequence)).toString();
        return call(turn("ingress", at).put("session", "source").put("wire", body));
    }

    JsonNode progress(long at, String source, String entity, long through) throws Exception {
        var body = JSON.createObjectNode().put("sourceId", source).put("epoch", "run")
                .put("sourceEntityId", entity).put("throughSequence", through);
        return call(turn("progress", at).put("session", "progress").put("wire", body.toString()));
    }

    JsonNode snapshot(String view, String entity) throws Exception {
        var command = turn("observe-installed", time);
        command.set("observationTargets", JSON.createArrayNode().add(JSON.createObjectNode()
                .put("viewId", view).put("entityId", entity)));
        return JSON.readTree(call(command).path("snapshots").get(0).asString());
    }

    List<JsonNode> advance(long until) throws Exception {
        var effects = new ArrayList<JsonNode>();
        for (;;) {
            pending.sort(Comparator.comparingLong((Pending p) -> p.effect().path("at").longValue())
                    .thenComparingLong(Pending::round)
                    .thenComparingInt(p -> p.effect().path("phase").intValue())
                    .thenComparingLong(p -> p.effect().path("task").longValue()));
            if (pending.isEmpty() || pending.getFirst().effect().path("at").longValue() > until) break;
            var task = pending.removeFirst();
            round = task.round();
            call(turn("task", task.effect().path("at").longValue())
                    .put("task", task.effect().path("task").longValue())).path("effects").forEach(effects::add);
        }
        round = 0;
        call(turn("observe", until));
        return effects;
    }

    static JsonNode receipt(JsonNode response, String kind) {
        return response.path("effects").valueStream().filter(e -> e.path("kind").asString().equals(kind))
                .map(e -> JSON.readTree(e.path("wire").asString())).findFirst().orElseThrow();
    }

    @Override public void close() throws Exception { call(turn("shutdown", time)); }
}
