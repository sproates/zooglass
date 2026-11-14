package io.zooglass.simulation;

import io.zooglass.runtime.PublicationJson;
import io.zooglass.runtime.TimelineRuntime;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.function.Function;

/** Owns the framed process boundary and capability handshake, never runtime state. */
enum HostProtocol {
    V1(1),
    V2(2);

    private final int version;

    HostProtocol(int version) {
        this.version = version;
    }

    static HostProtocol selected() {
        return switch (System.getProperty("zooglass.simulation.protocol", "1")) {
            case "1" -> V1;
            case "2" -> V2;
            default -> throw new IllegalArgumentException("Unsupported simulation host protocol");
        };
    }

    @FunctionalInterface
    interface CommandHandler {
        Object execute(JsonNode command) throws Exception;
    }

    private static final int CAP = 16 * 1024 * 1024;
    static final JsonMapper JSON =
            JsonMapper.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
                    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .build();

    void serve(Function<Boolean, CommandHandler> createHandler) throws Exception {
        var output = new DataOutputStream(System.out);
        System.setOut(System.err); // Libraries may log; stdout belongs exclusively to framing.
        String artifactPath = System.getProperty("zooglass.simulation.artifact");
        if (artifactPath == null || artifactPath.isBlank())
            throw new IllegalArgumentException(
                    "Missing required system property zooglass.simulation.artifact; launch through Workbench");
        var artifact = Path.of(artifactPath);
        String digest =
                HexFormat.of()
                        .formatHex(
                                MessageDigest.getInstance("SHA-256")
                                        .digest(Files.readAllBytes(artifact)));
        String sqliteVersion = this == V2 ? availableSqliteVersion() : null;
        var handler = createHandler.apply(sqliteVersion != null);
        write(output, handshake(digest, sqliteVersion));
        var input = new DataInputStream(System.in);
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
            write(output, handler.execute(decodeCommand(bytes)));
        }
    }

    Map<String, Object> handshake(String digest, String sqliteVersion) {
        var environment = new LinkedHashMap<>(Map.of(
                "javaRuntime", System.getProperty("java.runtime.version"),
                "javaVendor", System.getProperty("java.vendor"),
                "os", System.getProperty("os.name"),
                "arch", System.getProperty("os.arch"),
                "locale", Locale.getDefault().toLanguageTag(),
                "timezone", TimeZone.getDefault().getID()));
        if (sqliteVersion != null) environment.put("sqliteVersion", sqliteVersion);
        var handshake = Map.of(
                "protocol", version,
                "fixture", "timeline-proof-v1",
                "artifact", digest,
                "frameCap", CAP,
                "storage", sqliteVersion == null ? List.of("memory") : List.of("memory", "sqlite"),
                "protectedAccess", false,
                this == V1 ? "configurationAdmission" : "memoryLifecycle", 1,
                "documentFormats", this == V1 ? List.of("timeline-simulation/v1") : List.of(),
                "environment", environment);
        if (this == V1) return handshake;
        var capabilities = new LinkedHashMap<String, Object>(handshake);
        capabilities.put("installedObservations", 1);
        capabilities.put("memorySequenceFleet", 1);
        capabilities.put("wallClockAdjustments", 1);
        if (sqliteVersion != null) capabilities.put("sqliteLifecycle", 1);
        return capabilities;
    }

    static String availableSqliteVersion() {
        try {
            return TimelineRuntime.sqliteVersion();
        } catch (IllegalStateException | LinkageError unavailable) {
            System.err.println("SQLite lifecycle unavailable: " + unavailable.getClass().getSimpleName());
            return null;
        }
    }

    static JsonNode decodeCommand(byte[] bytes) throws IOException {
        String command;
        try {
            command =
                    StandardCharsets.UTF_8.newDecoder()
                            .decode(ByteBuffer.wrap(bytes))
                            .toString();
        } catch (CharacterCodingException failure) {
            throw new IOException("Command frame is not valid UTF-8", failure);
        }
        return JSON.readTree(command);
    }

    private static void write(DataOutputStream out, Object value) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(value);
        if (bytes.length > CAP) throw new IOException("Frame overflow");
        out.writeInt(bytes.length);
        out.write(bytes);
        out.flush();
    }

    void validateFields(JsonNode command, String op) {
        var fields =
                new HashSet<>(
                        Set.of(
                                "op", "turnId", "runtimeGeneration", "timeMs", "monotonicMs",
                                "wallMillis"));
        fields.addAll(
                switch (op) {
                    case "initialize" -> Set.of("policy");
                    case "inspect-configuration" -> Set.of("wire");
                    case "initialize-document" -> this == V1
                            ? Set.of("wire", "epochMillis")
                            : Set.of("wire", "epochMillis", "startTimeMs", "database",
                                    "observationTargets", "wallOffsetMillis", "profile");
                    case "wall-clock-set" -> {
                        if (this != V2) throw new IllegalArgumentException("Wall adjustments require protocol 2");
                        yield Set.of();
                    }
                    case "observe-installed" -> {
                        if (this != V2) throw new IllegalArgumentException("Installed observations require protocol 2");
                        yield Set.of("observationTargets");
                    }
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

    static String text(JsonNode node, String key) {
        if (!node.path(key).isTextual() || node.path(key).asString().isBlank())
            throw new IllegalArgumentException("Expected text " + key);
        return node.path(key).asString();
    }

    static long integer(JsonNode node, String key) {
        return boundedInteger(node, key, 0);
    }

    static long signedInteger(JsonNode node, String key) {
        return boundedInteger(node, key, -PublicationJson.MAX_SEQUENCE);
    }

    private static long boundedInteger(JsonNode node, String key, long min) {
        var value = node.path(key);
        if (!value.isIntegralNumber()
                || !value.canConvertToLong()
                || value.longValue() < min
                || value.longValue() > PublicationJson.MAX_SEQUENCE)
            throw new IllegalArgumentException("Expected bounded integer " + key);
        return value.longValue();
    }
}
