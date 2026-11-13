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
                        false));
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
        if (id != nextTurn++
                || id >= 10000
                || integer(command, "runtimeGeneration") != 1
                || integer(command, "monotonicMs") != at
                || integer(command, "wallMillis") != 1_000_000 + at)
            throw new IllegalArgumentException("Invalid command identity or clocks");
        if (id == 0 && at != 0)
            throw new IllegalArgumentException("Initial elapsed time must be zero");
        turns.begin(at);
        String op = command.path("op").asString();
        if ((runtime == null) != op.equals("initialize"))
            throw new IllegalArgumentException("Invalid lifecycle");
        switch (op) {
            case "initialize" -> initialize(command.path("policy").asString());
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
                sessions.put(name, session);
                if (name.startsWith("viewer-")) subscriptions.afterConnectionEstablished(session);
                else if (!name.startsWith("source-"))
                    throw new IllegalArgumentException("Invalid session role");
            }
            case "ingress" -> {
                var session = session(command, "source-");
                ingress.handleMessage(session, new TextMessage(text(command, "wire")));
            }
            case "subscribe" ->
                    subscriptions.handleMessage(
                            session(command, "viewer-"), new TextMessage(text(command, "wire")));
            case "disconnect" -> session(command, "source-").close();
            case "stall" -> {
                session(command, "viewer-");
                delivery.stall(text(command, "session"));
            }
            case "release" -> {
                session(command, "viewer-");
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
        runtime = TimelineRuntime.create(config, turns);
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

    private TimelineSession session(JsonNode command, String prefix) {
        String id = text(command, "session");
        var session = sessions.get(id);
        if (!id.startsWith(prefix) || session == null || !session.isOpen())
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
