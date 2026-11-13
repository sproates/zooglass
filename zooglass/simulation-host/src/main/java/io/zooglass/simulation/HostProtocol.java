package io.zooglass.simulation;

import io.zooglass.runtime.PublicationJson;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

/** Owns the framed process boundary and capability handshake, never runtime state. */
final class HostProtocol {
    private HostProtocol() {}

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

    static void serve(CommandHandler handler) throws Exception {
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
                        List.of("timeline-simulation/v1"),
                        "environment",
                        Map.of("javaRuntime", System.getProperty("java.runtime.version"),
                                "javaVendor", System.getProperty("java.vendor"),
                                "os", System.getProperty("os.name"),
                                "arch", System.getProperty("os.arch"),
                                "locale", Locale.getDefault().toLanguageTag(),
                                "timezone", TimeZone.getDefault().getID())));
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
            var command = JSON.readTree(new String(bytes, StandardCharsets.UTF_8));
            write(output, handler.execute(command));
        }
    }

    private static void write(DataOutputStream out, Object value) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(value);
        if (bytes.length > CAP) throw new IOException("Frame overflow");
        out.writeInt(bytes.length);
        out.write(bytes);
        out.flush();
    }

    static void validateFields(JsonNode command, String op) {
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

    static String text(JsonNode node, String key) {
        if (!node.path(key).isTextual() || node.path(key).asString().isBlank())
            throw new IllegalArgumentException("Expected text " + key);
        return node.path(key).asString();
    }

    static long integer(JsonNode node, String key) {
        var value = node.path(key);
        if (!value.isIntegralNumber()
                || !value.canConvertToLong()
                || value.longValue() < 0
                || value.longValue() > PublicationJson.MAX_SEQUENCE)
            throw new IllegalArgumentException("Expected bounded integer " + key);
        return value.longValue();
    }
}
