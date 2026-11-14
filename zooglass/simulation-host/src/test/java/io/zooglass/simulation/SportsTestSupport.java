package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.OrderTestSupport.turn;

import io.zooglass.runtime.TimelineProfile;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Drives only the real host's commands and declared task queue, never fact reconciliation. */
final class SportsTestSupport implements AutoCloseable {
    final TimelineHost host = new TimelineHost(HostProtocol.V2, true);
    private long next;
    private long time;
    private long round;
    private record Pending(JsonNode effect, long round) {}
    private final List<Pending> pending = new ArrayList<>();

    static ObjectNode configuration() throws Exception {
        try (var input = SportsTestSupport.class.getResourceAsStream("/sports-runtime.json")) {
            return (ObjectNode) JSON.readTree(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    static ObjectNode initialization(Path database) throws Exception {
        return turn("initialize-document", 0).put("startTimeMs", 0).put("epochMillis", OrderTestSupport.EPOCH)
                .put("database", database.toString()).put("profile", TimelineProfile.SQLITE_SPORTS)
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

    static String fact(long sequence, long birth, long revision, String operation, String payload) {
        var body = JSON.createObjectNode().put("sourceId", "match-feed").put("epoch", "run")
                .put("sourceEntityId", "match-1").put("publicationSequence", sequence)
                .put("type", "home.contribution");
        body.set("fact", JSON.createObjectNode().put("birthSequence", birth).put("revision", revision).put("operation", operation));
        body.set("payload", JSON.readTree(payload));
        return body.toString();
    }

    JsonNode publish(String wire) throws Exception {
        return call(turn("ingress", time).put("session", "source").put("wire", wire));
    }

    static String control(String view, long floor, String... fields) {
        var body = JSON.createObjectNode().put("viewId", view).put("entityId", "match-1")
                .put("minimumBirthSequence", floor);
        var names = body.putArray("fields");
        for (var field : fields) names.add(field);
        return body.toString();
    }

    JsonNode retire(String view, long floor, String... fields) throws Exception {
        return call(turn("retirement", time).put("session", "retirement").put("wire", control(view, floor, fields)));
    }

    JsonNode snapshot(String view) throws Exception {
        var command = turn("observe-installed", time);
        command.set("observationTargets", JSON.createArrayNode().add(JSON.createObjectNode()
                .put("viewId", view).put("entityId", "match-1")));
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

    static List<JsonNode> states(JsonNode response) {
        return response.path("effects").valueStream().filter(e -> e.path("kind").asString().equals("state"))
                .map(e -> JSON.readTree(e.path("wire").asString())).toList();
    }

    @Override public void close() throws Exception { call(turn("shutdown", time)); }
}
