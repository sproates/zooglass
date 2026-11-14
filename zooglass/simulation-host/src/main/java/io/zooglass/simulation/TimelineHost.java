package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.HostProtocol.integer;
import static io.zooglass.simulation.HostProtocol.text;

import io.zooglass.access.ViewResource;
import io.zooglass.delivery.SlowClientPolicy;
import io.zooglass.delivery.SnapshotBroadcaster;
import io.zooglass.delivery.SnapshotSubscriptions;
import io.zooglass.delivery.TimelineDelivery;
import io.zooglass.runtime.EventIngress;
import io.zooglass.runtime.ProgressIngress;
import io.zooglass.runtime.PublicationJson;
import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.TimelineProfile;
import io.zooglass.runtime.TimelineRuntime;
import io.zooglass.runtime.ViewCoordinator;

import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;

import tools.jackson.databind.JsonNode;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Owns one controlled runtime and its sessions; framing belongs to HostProtocol. */
public final class TimelineHost {
    private final TurnContext turns = new TurnContext();
    private final HostProtocol protocol;
    private final boolean sqliteAvailable;
    private final HostTurns identities;
    private final Map<String, Connection> sessions = new LinkedHashMap<>();
    private ViewCoordinator runtime;
    private TimelineDelivery delivery;
    private SnapshotBroadcaster broadcaster;
    private SnapshotSubscriptions subscriptions;
    private EventIngress ingress;
    private ProgressIngress progress;
    private boolean orderProfile;
    private boolean stopped;
    private boolean documentMode;
    private boolean durable;
    private boolean sequenceFleet;
    private RuntimeConfiguration documentConfiguration;

    private enum Role { CLIENT, SOURCE, PROGRESS }

    private record Connection(TimelineSession session, Role role) {}

    TimelineHost(HostProtocol protocol, boolean sqliteAvailable) {
        this.protocol = protocol;
        this.sqliteAvailable = sqliteAvailable;
        identities = new HostTurns(protocol);
    }

    public static void main(String[] args) throws Exception {
        var protocol = HostProtocol.selected();
        protocol.serve(sqliteAvailable -> new TimelineHost(protocol, sqliteAvailable)::command);
    }

    Map<String, Object> command(JsonNode command) throws Exception {
        if (stopped) throw new IllegalStateException("Runtime already stopped");
        String op = text(command, "op");
        protocol.validateFields(command, op);
        if ((sequenceFleet || orderProfile) && op.equals("wall-clock-set"))
            throw new IllegalArgumentException("This profile does not support wall-clock adjustments");
        var turn = identities.admit(command, op);
        if (op.equals("inspect-configuration")) return inspectConfiguration(command, turn);

        turns.begin(turn.timeMs());
        List<String> snapshots = null;
        switch (op) {
            case "initialize" -> initialize(text(command, "policy"), turn.generation());
            case "initialize-document" -> snapshots = initializeDocument(command, turn.generation());
            case "connect" -> connect(command);
            case "ingress" -> {
                var session = session(command, Role.SOURCE);
                ingress.handleMessage(session, new TextMessage(text(command, "wire")));
                if (durable) TimelineRuntime.verifyStorageAvailable(runtime);
            }
            case "progress" -> {
                if (!orderProfile) throw new IllegalArgumentException("Progress requires the Order profile");
                progress.handleMessage(session(command, Role.PROGRESS), new TextMessage(text(command, "wire")));
                TimelineRuntime.verifyStorageAvailable(runtime);
            }
            case "subscribe" -> {
                subscriptions.handleMessage(
                        session(command, Role.CLIENT), new TextMessage(text(command, "wire")));
                if (durable) TimelineRuntime.verifyStorageAvailable(runtime);
            }
            case "disconnect" -> disconnect(text(command, "session"));
            case "stall" -> delivery.stall(session(command, Role.CLIENT).getId());
            case "release" -> {
                var session = session(command, Role.CLIENT);
                if (!command.path("fail").isBoolean())
                    throw new IllegalArgumentException("Expected boolean fail");
                delivery.release(session.getId(), command.path("fail").asBoolean());
            }
            case "task" -> turns.dispatch(integer(command, "task"));
            case "observe-installed" -> {
                if (protocol != HostProtocol.V2 || documentConfiguration == null)
                    throw new IllegalArgumentException("Installed observations require an initialized v2 document");
                snapshots = installed(observationTargets(command.get("observationTargets"), documentConfiguration));
            }
            // Neither operation invokes the runtime. HostTurns owns wall-clock changes.
            case "observe", "wall-clock-set" -> {}
            case "shutdown" -> shutdown();
            default -> throw new IllegalArgumentException("Unsupported POC operation");
        }
        return response(turn, snapshots);
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
                        "documentProfile", TimelineProfile.inspect(config)));
    }

    private Map<String, Object> response(HostTurns.Turn turn, List<String> snapshots) {
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
        if (snapshots != null) clocks.put("snapshots", snapshots);
        return clocks;
    }

    private List<String> initializeDocument(JsonNode command, RuntimeGeneration generation) {
        var config = TimelineRuntime.inspectConfiguration(text(command, "wire"));
        String profile = TimelineProfile.inspect(config);
        boolean fleet = TimelineProfile.MEMORY_SEQUENCE_FLEET.equals(profile);
        boolean order = TimelineProfile.SQLITE_ORDER.equals(profile);
        if (!TimelineProfile.NAME.equals(profile)
                && !(protocol == HostProtocol.V2
                        && (TimelineProfile.SQLITE_RESTART.equals(profile) || fleet || order)))
            throw new IllegalArgumentException("Unsupported document configuration profile");
        if ((command.has("profile") && !profile.equals(text(command, "profile")))
                || ((fleet || order) && !command.has("profile")))
            throw new IllegalArgumentException("Document profile agreement is required");
        if (fleet && generation.number() != 1)
            throw new IllegalArgumentException("Sequence fleet requires runtime generation 1");
        if (order && (generation.number() != 1 || generation.startTimeMs() != 0
                || generation.wallMillis(0) != generation.epochMillis()))
            throw new IllegalArgumentException("Order profile requires generation 1 at time zero without wall adjustment");
        if ((TimelineProfile.SQLITE_RESTART.equals(profile) || order) && !sqliteAvailable)
            throw new IllegalArgumentException("SQLite lifecycle is unavailable");

        Path database = database(command, config.storage(), generation);
        if (order && Files.exists(database, LinkOption.NOFOLLOW_LINKS))
            throw new IllegalArgumentException("Order profile requires a new database path");
        var targets = command.has("observationTargets")
                ? observationTargets(command.get("observationTargets"), config) : null;
        documentMode = true;
        sequenceFleet = fleet;
        orderProfile = order;
        documentConfiguration = config;
        durable = database != null;
        compose(config, generation, database);
        if (targets == null) return null;
        try {
            return installed(targets);
        } catch (RuntimeException failure) {
            try {
                shutdown();
            } catch (RuntimeException cleanupFailure) {
                failure.addSuppressed(cleanupFailure);
            }
            throw failure;
        }
    }

    private List<String> installed(List<ViewResource> targets) {
        return TimelineRuntime.installedSnapshots(runtime, targets).stream()
                .map(snapshot -> canonical(JSON.writeValueAsString(snapshot)))
                .toList();
    }

    private static Path database(JsonNode command, String storage, RuntimeGeneration generation) {
        if (!storage.equals("sqlite")) {
            if (command.has("database"))
                throw new IllegalArgumentException("Memory runtime does not accept a database path");
            return null;
        }
        var path = Path.of(text(command, "database"));
        if (!path.isAbsolute() || path.getFileName() == null)
            throw new IllegalArgumentException("SQLite requires an absolute database file path");
        if (generation.number() > 1 && !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
            throw new IllegalArgumentException("SQLite restart requires an existing regular database file");
        return path;
    }

    private static List<ViewResource> observationTargets(JsonNode value, RuntimeConfiguration config) {
        if (value == null || !value.isArray() || value.size() > 64)
            throw new IllegalArgumentException("Expected at most 64 observation targets");
        var targets = new ArrayList<ViewResource>();
        var seen = new HashSet<ViewResource>();
        var configuredViews = config.views().stream().map(RuntimeConfiguration.View::id).toList();
        for (var node : value) {
            if (!node.isObject() || node.size() != 2 || !node.has("viewId") || !node.has("entityId"))
                throw new IllegalArgumentException("Expected viewId and entityId observation target");
            var target = new ViewResource(text(node, "viewId"), text(node, "entityId"));
            if (!configuredViews.contains(target.viewId()) || target.entityId().length() > 1024)
                throw new IllegalArgumentException("Invalid observation target view or entity");
            if (!seen.add(target)) throw new IllegalArgumentException("Duplicate observation target");
            targets.add(target);
        }
        return targets;
    }

    private void shutdown() {
        try (var closingRuntime = runtime) {
            if (broadcaster != null) broadcaster.close();
            else if (delivery != null) delivery.close();
        } finally {
            sessions.clear();
            stopped = true;
        }
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
        compose(config, generation, null);
    }

    private void compose(RuntimeConfiguration config, RuntimeGeneration generation, Path database) {
        runtime = TimelineRuntime.create(config, turns, generation, database);
        try {
            runtime.listen(
                    snapshot ->
                            turns.effect(
                                    Map.of(
                                            "kind", "state", "wire",
                                            JSON.writeValueAsString(snapshot))));
            delivery = new TimelineDelivery(turns);
            broadcaster = delivery.broadcaster(JSON, runtime);
            subscriptions = new SnapshotSubscriptions(JSON, broadcaster);
            ingress = new EventIngress(runtime, JSON);
            progress = new ProgressIngress(runtime, JSON);
        } catch (RuntimeException failure) {
            try {
                shutdown();
            } catch (RuntimeException cleanupFailure) {
                failure.addSuppressed(cleanupFailure);
            }
            throw failure;
        }
    }

    private void connect(JsonNode command) {
        String name = text(command, "session");
        if (sessions.containsKey(name) || sessions.size() >= 10)
            throw new IllegalArgumentException("Session identity/limit");
        Role role = role(command, name);
        var session = new TimelineSession(name, turns, wire -> turns.effect(
                Map.of("kind", role == Role.PROGRESS ? "control-receipt" : "receipt",
                        "session", name, "wire", wire)));
        sessions.put(name, new Connection(session, role));
        if (role == Role.CLIENT) subscriptions.afterConnectionEstablished(session);
    }

    private Role role(JsonNode command, String name) {
        if (documentMode) {
            return switch (text(command, "role")) {
                case "client" -> Role.CLIENT;
                case "source" -> Role.SOURCE;
                case "progress" -> {
                    if (!orderProfile) throw new IllegalArgumentException("Progress requires the Order profile");
                    yield Role.PROGRESS;
                }
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
