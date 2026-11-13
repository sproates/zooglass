package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.HostProtocol.integer;
import static io.zooglass.simulation.HostProtocol.text;

import io.zooglass.delivery.SlowClientPolicy;
import io.zooglass.delivery.SnapshotBroadcaster;
import io.zooglass.delivery.SnapshotSubscriptions;
import io.zooglass.delivery.TimelineDelivery;
import io.zooglass.runtime.EventIngress;
import io.zooglass.runtime.PublicationJson;
import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.TimelineProfile;
import io.zooglass.runtime.TimelineRuntime;
import io.zooglass.runtime.ViewCoordinator;

import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;

import tools.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Owns one controlled runtime and its sessions; framing belongs to HostProtocol. */
public final class TimelineHost {
    private final TurnContext turns = new TurnContext();
    private final HostProtocol protocol;
    private final HostTurns identities;
    private final Map<String, Connection> sessions = new LinkedHashMap<>();
    private ViewCoordinator runtime;
    private TimelineDelivery delivery;
    private SnapshotBroadcaster broadcaster;
    private SnapshotSubscriptions subscriptions;
    private EventIngress ingress;
    private boolean stopped;
    private boolean documentMode;

    private enum Role { CLIENT, SOURCE }

    private record Connection(TimelineSession session, Role role) {}

    TimelineHost(HostProtocol protocol) {
        this.protocol = protocol;
        identities = new HostTurns(protocol);
    }

    public static void main(String[] args) throws Exception {
        var protocol = HostProtocol.selected();
        protocol.serve(new TimelineHost(protocol)::command);
    }

    Map<String, Object> command(JsonNode command) throws Exception {
        if (stopped) throw new IllegalStateException("Runtime already stopped");
        String op = text(command, "op");
        protocol.validateFields(command, op);
        var turn = identities.admit(command, op);
        if (op.equals("inspect-configuration")) return inspectConfiguration(command, turn);

        turns.begin(turn.timeMs());
        switch (op) {
            case "initialize" -> initialize(text(command, "policy"), turn.generation());
            case "initialize-document" -> {
                var config = TimelineRuntime.inspectConfiguration(text(command, "wire"));
                if (!TimelineProfile.supports(config))
                    throw new IllegalArgumentException("Unsupported document configuration profile");
                documentMode = true;
                compose(config, turn.generation());
            }
            case "connect" -> connect(command);
            case "ingress" -> {
                var session = session(command, Role.SOURCE);
                ingress.handleMessage(session, new TextMessage(text(command, "wire")));
            }
            case "subscribe" ->
                    subscriptions.handleMessage(
                            session(command, Role.CLIENT), new TextMessage(text(command, "wire")));
            case "disconnect" -> disconnect(text(command, "session"));
            case "stall" -> delivery.stall(session(command, Role.CLIENT).getId());
            case "release" -> {
                var session = session(command, Role.CLIENT);
                if (!command.path("fail").isBoolean())
                    throw new IllegalArgumentException("Expected boolean fail");
                delivery.release(session.getId(), command.path("fail").asBoolean());
            }
            case "task" -> turns.dispatch(integer(command, "task"));
            case "observe" -> {} // No snapshot read: observations cannot repair a missing alarm.
            case "shutdown" -> {
                broadcaster.close();
                runtime.close();
                sessions.clear();
                stopped = true;
            }
            default -> throw new IllegalArgumentException("Unsupported POC operation");
        }
        return response(turn);
    }

    private Map<String, Object> inspectConfiguration(JsonNode command, HostTurns.Turn turn) {
        var config = TimelineRuntime.inspectConfiguration(text(command, "wire"));
        return Map.of(
                "turnId", turn.id(),
                "runtimeGeneration", turn.generation().number(),
                "timeMs", turn.timeMs(),
                "effects", List.of(),
                "pendingTasks", 0,
                "heldFrames", 0,
                "configuration", Map.of(
                        "contractVersion", config.contractVersion(),
                        "storage", config.storage(),
                        "documentProfile", TimelineProfile.supports(config)
                                ? TimelineProfile.NAME : "unsupported"));
    }

    private Map<String, Object> response(HostTurns.Turn turn) {
        int pending = turns.pendingCount();
        int held = delivery.heldCount();
        var effects =
                turns.end().stream()
                        .map(
                                effect -> {
                                    var result = new TreeMap<String, Object>(effect);
                                    if (effect.get("wire") instanceof String wire)
                                        result.put("wire", canonical(wire));
                                    return result;
                                })
                        .toList();
        var response = Map.<String, Object>of(
                "turnId", turn.id(),
                "runtimeGeneration", turn.generation().number(),
                "timeMs", turn.timeMs(),
                "effects", effects,
                "pendingTasks", pending,
                "heldFrames", held,
                "diagnostics", turns.diagnostics());
        if (protocol == HostProtocol.V1) return response;
        var clocks = new LinkedHashMap<>(response);
        clocks.put("monotonicMs", turn.generation().monotonicMillis(turn.timeMs()));
        clocks.put("wallMillis", turn.generation().wallMillis(turn.timeMs()));
        return clocks;
    }

    private void initialize(String policy, RuntimeGeneration generation) {
        if (!Set.of("coalesceLatestState", "disconnectOnOverflow").contains(policy))
            throw new IllegalArgumentException("Unsupported policy");
        var field =
                new RuntimeConfiguration.Field(
                        "feed",
                        "position",
                        "arrival",
                        null,
                        null,
                        null,
                        new RuntimeConfiguration.Freshness("receiptAge", 100L));
        var config =
                new RuntimeConfiguration(
                        2,
                        "memory",
                        20,
                        20,
                        20,
                        List.of(new RuntimeConfiguration.Source("feed", "v1")),
                        List.of(
                                new RuntimeConfiguration.View(
                                        "position", Map.of("position", field))),
                        new RuntimeConfiguration.Delivery(
                                null, SlowClientPolicy.select(policy), 3, 65536L));
        compose(config, generation);
    }

    private void compose(RuntimeConfiguration config, RuntimeGeneration generation) {
        runtime = TimelineRuntime.create(config, turns, generation);
        runtime.listen(
                snapshot ->
                        turns.effect(
                                Map.of(
                                        "kind",
                                        "state",
                                        "wire",
                                        JSON.writeValueAsString(snapshot))));
        delivery = new TimelineDelivery(turns);
        broadcaster = delivery.broadcaster(JSON, runtime);
        subscriptions = new SnapshotSubscriptions(JSON, broadcaster);
        ingress = new EventIngress(runtime, JSON);
    }

    private void connect(JsonNode command) {
        String name = text(command, "session");
        if (sessions.containsKey(name) || sessions.size() >= 10)
            throw new IllegalArgumentException("Session identity/limit");
        Role role = role(command, name);
        var session = new TimelineSession(name, turns, wire -> turns.effect(
                Map.of("kind", "receipt", "session", name, "wire", wire)));
        sessions.put(name, new Connection(session, role));
        if (role == Role.CLIENT) subscriptions.afterConnectionEstablished(session);
    }

    private Role role(JsonNode command, String name) {
        if (documentMode) {
            return switch (text(command, "role")) {
                case "client" -> Role.CLIENT;
                case "source" -> Role.SOURCE;
                default -> throw new IllegalArgumentException("Invalid session role");
            };
        }
        if (name.startsWith("viewer-")) return Role.CLIENT;
        if (name.startsWith("source-")) return Role.SOURCE;
        throw new IllegalArgumentException("Invalid session role");
    }

    private void disconnect(String name) {
        var connection = sessions.get(name);
        if (connection == null) throw new IllegalArgumentException("Unavailable session");
        var session = connection.session();
        if (connection.role() == Role.CLIENT)
            subscriptions.afterConnectionClosed(session, CloseStatus.NORMAL);
        if (session.isOpen()) session.close();
        sessions.remove(name);
    }

    private TimelineSession session(JsonNode command, Role role) {
        String id = text(command, "session");
        var connection = sessions.get(id);
        if (connection == null || connection.role() != role || !connection.session().isOpen())
            throw new IllegalArgumentException("Unavailable session");
        return connection.session();
    }

    private static String canonical(String wire) {
        return JSON.writeValueAsString(PublicationJson.content(JSON.readTree(wire)));
    }
}
