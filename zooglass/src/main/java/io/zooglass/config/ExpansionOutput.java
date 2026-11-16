package io.zooglass.config;

import io.zooglass.runtime.ConfigurationInspection;

import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;

/** Bounded deterministic runtime bytes and exclusive ownership of a new output file. */
final class ExpansionOutput {
    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    static final int MAX_BYTES = 16 * 1024 * 1024;

    record Metadata(String inputSha256, String outputSha256, String toolJarSha256) {}

    /** Cleanup may remove only the regular file whose identity was captured at creation. */
    record CreatedFile(Path path, Object fileKey) {
        void discard() throws IOException {
            // Some providers cannot identify files. Retaining a failed output is safer than
            // deleting a replacement whose ownership cannot be established.
            if (fileKey == null) return;
            try {
                var current = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (current.isRegularFile() && fileKey.equals(current.fileKey())) {
                    Files.delete(path);
                }
            } catch (NoSuchFileException absent) {
                // Nothing remains to clean up.
            }
        }
    }

    @FunctionalInterface
    interface OutputFactory {
        OutputStream create(Path destination) throws IOException;
    }

    static final class TooLarge extends RuntimeException {}

    private ExpansionOutput() {}

    static byte[] encode(ConfigurationAuthoring.Resolved document) {
        var bytes = new ByteArrayOutputStream();
        OutputStream bounded = new OutputStream() {
            @Override
            public void write(int value) {
                if (bytes.size() >= MAX_BYTES) throw new TooLarge();
                bytes.write(value);
            }

            @Override
            public void write(byte[] value, int offset, int length) {
                if (length > MAX_BYTES - bytes.size()) throw new TooLarge();
                bytes.write(value, offset, length);
            }
        };
        try (var generator = MAPPER.createGenerator(bounded)) {
            write(generator, document.root(), "", document.fields());
        }
        if (bytes.size() >= MAX_BYTES) throw new TooLarge();
        bytes.write('\n');
        return bytes.toByteArray();
    }

    private static void write(JsonGenerator generator, JsonNode value, String path, Map<String, JsonNode> fields) {
        value = fields.getOrDefault(path, value);
        if (value.isObject()) {
            generator.writeStartObject();
            for (String key : value.propertyNames().stream().sorted().toList()) {
                generator.writeName(key);
                write(generator, value.path(key), path + "/" + ConfigurationInspection.pointerToken(key), fields);
            }
            generator.writeEndObject();
        } else if (value.isArray()) {
            generator.writeStartArray();
            for (int index = 0; index < value.size(); index++) {
                write(generator, value.path(index), path + "/" + index, fields);
            }
            generator.writeEndArray();
        } else {
            generator.writeTree(value);
        }
    }

    static Metadata metadata(byte[] input, byte[] output) throws IOException {
        // The protection domain identifies the actual class-loading source. No user property
        // may substitute an unrelated file; expansion requires a packaged application.
        try {
            var location = ExpansionOutput.class.getProtectionDomain().getCodeSource().getLocation();
            String url = location.toExternalForm();
            if (!url.startsWith("jar:nested:") || !url.contains("/!BOOT-INF/classes/!/")) {
                throw new IOException("Cannot identify the prepared application JAR");
            }
            String outer = url.substring("jar:nested:".length(), url.indexOf("/!BOOT-INF/classes/!/"));
            Path jar = Path.of(java.net.URI.create("file:" + outer));
            var digest = MessageDigest.getInstance("SHA-256");
            try (var stream = Files.newInputStream(jar)) {
                byte[] buffer = new byte[64 * 1024];
                for (int count; (count = stream.read(buffer)) != -1;) digest.update(buffer, 0, count);
            }
            return new Metadata(hash(input), hash(output), HexFormat.of().formatHex(digest.digest()));
        } catch (java.security.NoSuchAlgorithmException | IllegalArgumentException failure) {
            throw new IOException("Cannot identify the prepared application JAR", failure);
        }
    }

    private static String hash(byte[] bytes) throws java.security.NoSuchAlgorithmException {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    static CreatedFile writeNew(Path destination, byte[] bytes) throws IOException {
        return writeNew(destination, bytes, path -> Files.newOutputStream(
                path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE));
    }

    static CreatedFile writeNew(Path destination, byte[] bytes, OutputFactory factory) throws IOException {
        CreatedFile created = null;
        try {
            try (var output = factory.create(destination)) {
                var attributes = Files.readAttributes(destination, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                created = new CreatedFile(destination, attributes.fileKey());
                output.write(bytes);
            }
        } catch (IOException | RuntimeException failure) {
            if (created != null) {
                try { created.discard(); }
                catch (IOException | RuntimeException cleanupFailure) { failure.addSuppressed(cleanupFailure); }
            }
            throw failure;
        }
        return created;
    }
}
