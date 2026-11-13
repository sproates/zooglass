package io.zooglass.simulation;

import io.zooglass.delivery.*;
import io.zooglass.runtime.*;

import org.springframework.web.socket.TextMessage;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.*;
import tools.jackson.databind.json.JsonMapper;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Private, fixed-fixture POC executable. Not a server endpoint or a general scenario API. */
public final class TimelineHost {
    private static final int CAP = 16 * 1024 * 1024;
    private static final JsonMapper JSON =
            JsonMapper.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
                    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .build();
    private final TurnContext turns = new TurnContext();
    private final Map<String, TimelineSession> sessions = new LinkedHashMap<>();
    private ViewCoordinator runtime;
    private TimelineDelivery delivery;
    private SnapshotBroadcaster broadcaster;
    private SnapshotSubscriptions subscriptions;
    private EventIngress ingress;
    private long nextTurn;
    private boolean stopped;
    private long epoch = 1_000_000;
    private boolean documentMode;
    private final Map<String, String> roles = new LinkedHashMap<>();

    public static void main(String[] args) throws Exception {
        var output = new DataOutputStream(System.out);
        System.setOut(System.err); // Libraries may log; stdout belongs exclusively to framing.
        var artifact = Path.of(System.getProperty("zooglass.simulation.artifact"));
        String digest =
                HexFormat.of()
                        .formatHex(
                                MessageDigest.getInstance("SHA-256")
                                        .digest(Files.readAllBytes(artifact)));
        write(
                output,
                Map.of(
                        "protocol",
                        1,
                        "fixture",
                        "timeline-proof-v1",
                        "artifact",
                        digest,
                        "frameCap",
                        CAP,
                        "storage",
                        List.of("memory"),
                        "protectedAccess",
                        false,
                        "configurationAdmission",
                        1,
                        "documentFormats",
                        List.of("timeline-simulation/v1")));
        var input = new DataInputStream(System.in);
        var host = new TimelineHost();
        while (true) {
            int first = input.read();
            if (first < 0) return;
            int length =
                    (first << 24)
                            | (input.readUnsignedByte() << 16)
                            | (input.readUnsignedByte() << 8)
                            | input.readUnsignedByte();
            if (length < 1 || length > CAP) throw new IOException("Invalid frame size");
            byte[] bytes = input.readNBytes(length);
            if (bytes.length != length) throw new EOFException("Truncated frame");
            var command = JSON.readTree(new String(bytes, StandardCharsets.UTF_8));
            write(output, host.command(command));
        }
    }

    private static void write(DataOutputStream out, Object value) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(value);
        if (bytes.length > CAP) throw new IOException("Frame overflow");
        out.writeInt(bytes.length);
        out.write(bytes);
        out.flush();
    }

    private Object command(JsonNode command) throws Exception {
        if (stopped) throw new IllegalStateException("Runtime already stopped");
        long id = integer(command, "turnId");
        long at = integer(command, "timeMs");
        if (command.path("op").asString().equals("initialize-document") && runtime == null)
            epoch = integer(command, "epochMillis");
        if (id != nextTurn++
                || id >= 10000
                || integer(command, "runtimeGeneration") != 1
                || integer(command, "monotonicMs") != at
                || integer(command, "wallMillis") != Math.addExact(epoch, at))
            throw new IllegalArgumentException("Invalid command identity or clocks");
        if (id == 0 && at != 0)
            throw new IllegalArgumentException("Initial elapsed time must be zero");
        String op = text(command, "op");
        validateFields(command, op);
        if (op.equals("inspect-configuration")) {
            if (runtime != null || at != 0)
                throw new IllegalArgumentException(
                        "Configuration admission requires an unstarted host");
            var config = TimelineRuntime.inspectConfiguration(text(command, "wire"));
            return Map.of(
                    "turnId", id,
                    "runtimeGeneration", 1,
                    "timeMs", at,
                    "effects", List.of(),
                    "pendingTasks", 0,
                    "heldFrames", 0,
                    "configuration",
                    Map.of("contractVersion", config.contractVersion(), "storage", config.storage(),
                            "documentProfile", TimelineProfile.supports(config) ? TimelineProfile.NAME : "unsupported"));
        }
        if ((runtime == null) != (op.equals("initialize") || op.equals("initialize-document")))
            throw new IllegalArgumentException("Invalid lifecycle");
        turns.begin(at);
        switch (op) {
            case "initialize" -> initialize(command.path("policy").asString());
            case "initialize-document" -> {
                var config = TimelineRuntime.inspectConfiguration(text(command, "wire"));
                if (!TimelineProfile.supports(config))
                    throw new IllegalArgumentException("Unsupported document configuration profile");
                documentMode = true;
                compose(config);
            }
            case "connect" -> {
                String name = text(command, "session");
                if (sessions.containsKey(name) || sessions.size() >= 10)
                    throw new IllegalArgumentException("Session identity/limit");
                var session =
                        new TimelineSession(
                                name,
                                turns,
                                wire ->
                                        turns.effect(
                                                Map.of(
                                                        "kind", "receipt", "session", name, "wire",
                                                        wire)));
                String role = documentMode ? text(command, "role")
                        : name.startsWith("viewer-") ? "client" : name.startsWith("source-") ? "source" : "invalid";
                if (!Set.of("client", "source").contains(role))
                    throw new IllegalArgumentException("Invalid session role");
                sessions.put(name, session);
                roles.put(name, role);
                if (role.equals("client")) subscriptions.afterConnectionEstablished(session);
            }
            case "ingress" -> {
                var session = session(command, "source");
                ingress.handleMessage(session, new TextMessage(text(command, "wire")));
            }
            case "subscribe" ->
                    subscriptions.handleMessage(
                            session(command, "client"), new TextMessage(text(command, "wire")));
            case "disconnect" -> {
                String name = text(command, "session");
                var session = sessions.get(name);
                if (session == null) throw new IllegalArgumentException("Unavailable session");
                if ("client".equals(roles.get(name)))
                    subscriptions.afterConnectionClosed(session, org.springframework.web.socket.CloseStatus.NORMAL);
                if (session.isOpen()) session.close();
                sessions.remove(name);
                roles.remove(name);
            }
            case "stall" -> {
                session(command, "client");
                delivery.stall(text(command, "session"));
            }
            case "release" -> {
                session(command, "client");
                if (!command.path("fail").isBoolean())
                    throw new IllegalArgumentException("Expected boolean fail");
                delivery.release(text(command, "session"), command.path("fail").asBoolean());
            }
            case "task" -> turns.dispatch(integer(command, "task"));
            case "observe" -> {} // No snapshot read: observations cannot repair a missing alarm.
            case "shutdown" -> {
                broadcaster.close();
                runtime.close();
                stopped = true;
            }
            default -> throw new IllegalArgumentException("Unsupported POC operation");
        }
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
        return Map.of(
                "turnId",
                id,
                "runtimeGeneration",
                1,
                "timeMs",
                at,
                "effects",
                effects,
                "pendingTasks",
                pending,
                "heldFrames",
                held);
    }

    private void initialize(String policy) {
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
        compose(config);
    }

    private void compose(RuntimeConfiguration config) {
        runtime = TimelineRuntime.create(config, turns, epoch);
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

    private static void validateFields(JsonNode command, String op) {
        var fields =
                new HashSet<>(
                        Set.of(
                                "op", "turnId", "runtimeGeneration", "timeMs", "monotonicMs",
                                "wallMillis"));
        fields.addAll(
                switch (op) {
                    case "initialize" -> Set.of("policy");
                    case "inspect-configuration" -> Set.of("wire");
                    case "initialize-document" -> Set.of("wire", "epochMillis");
                    case "connect" -> Set.of("session", "role");
                    case "disconnect", "stall" -> Set.of("session");
                    case "ingress", "subscribe" -> Set.of("session", "wire");
                    case "release" -> Set.of("session", "fail");
                    case "task" -> Set.of("task");
                    case "observe", "shutdown" -> Set.of();
                    default -> throw new IllegalArgumentException("Unsupported POC operation");
                });
        if (command.properties().stream().anyMatch(entry -> !fields.contains(entry.getKey())))
            throw new IllegalArgumentException("Unsupported POC command field");
    }

    private TimelineSession session(JsonNode command, String role) {
        String id = text(command, "session");
        var session = sessions.get(id);
        if (!role.equals(roles.get(id)) || session == null || !session.isOpen())
            throw new IllegalArgumentException("Unavailable session");
        return session;
    }

    private static String text(JsonNode node, String key) {
        if (!node.path(key).isTextual() || node.path(key).asString().isBlank())
            throw new IllegalArgumentException("Expected text " + key);
        return node.path(key).asString();
    }

    private static long integer(JsonNode node, String key) {
        var value = node.path(key);
        if (!value.isIntegralNumber()
                || !value.canConvertToLong()
                || value.longValue() < 0
                || value.longValue() > PublicationJson.MAX_SEQUENCE)
            throw new IllegalArgumentException("Expected bounded integer " + key);
        return value.longValue();
    }

    private static String canonical(String wire) {
        return JSON.writeValueAsString(PublicationJson.content(JSON.readTree(wire)));
    }
}
