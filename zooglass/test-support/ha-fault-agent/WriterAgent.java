package io.zooglass.testagent;

import java.io.IOException;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.ProtectionDomain;
import java.util.HexFormat;
import java.util.Properties;
import java.util.zip.ZipFile;

/** Startup only. Returns two precomputed pause-only test classes for one verified service JAR. */
public final class WriterAgent implements ClassFileTransformer {
    private final String name;
    private final String marker;
    private final String originalSha;
    private final String instrumentedSha;
    private final byte[] instrumented;

    private WriterAgent(String name, String marker, String originalSha, String instrumentedSha, byte[] instrumented) {
        this.name = name;
        this.marker = marker;
        this.originalSha = originalSha;
        this.instrumentedSha = instrumentedSha;
        this.instrumented = instrumented;
    }

    public static void premain(String directory, Instrumentation instrumentation) throws Exception {
        WriterBarrier.initialise(Path.of(directory));
        var identity = new Properties();
        try (var input = WriterAgent.class.getResourceAsStream("/barrier/identity.properties")) { identity.load(input); }
        var service = Path.of(System.getProperty("java.class.path"));
        try (var file = Files.newInputStream(service)) {
            var digest = MessageDigest.getInstance("SHA-256");
            file.transferTo(new java.security.DigestOutputStream(java.io.OutputStream.nullOutputStream(), digest));
            if (!HexFormat.of().formatHex(digest.digest()).equals(identity.getProperty("serviceSha256"))) {
                throw new IllegalStateException("Prepared fault agent does not match this service");
            }
        }
        install(instrumentation, service, identity, "HaDelivery", "io/zooglass/delivery/", "agent.installed");
        install(instrumentation, service, identity, "PostgresAuthority", "io/zooglass/runtime/", "authority.installed");
    }

    private static void install(Instrumentation instrumentation, Path service, Properties identity,
            String simple, String prefix, String marker) throws Exception {
        String name = prefix + simple, original = identity.getProperty(simple + ".originalSha256");
        try (var jar = new ZipFile(service.toFile());
                var target = jar.getInputStream(jar.getEntry("BOOT-INF/classes/" + name + ".class"));
                var input = WriterAgent.class.getResourceAsStream("/barrier/" + simple + ".instrumented")) {
            byte[] bytes = input.readAllBytes();
            String computed = hash(bytes);
            if (!hash(target.readAllBytes()).equals(original)
                    || !computed.equals(identity.getProperty(simple + ".instrumentedSha256"))) {
                throw new IllegalStateException("Fault agent class hash mismatch: " + simple);
            }
            instrumentation.addTransformer(new WriterAgent(name, marker, original, computed, bytes));
        }
    }

    @Override
    public byte[] transform(ClassLoader loader, String name, Class<?> existing, ProtectionDomain domain, byte[] bytes) {
        if (!this.name.equals(name)) return null;
        try {
            if (existing != null || !hash(bytes).equals(originalSha)) throw new IOException("Unexpected target definition");
            WriterBarrier.marker(marker, originalSha + " " + instrumentedSha);
            return instrumented.clone();
        } catch (Exception failure) {
            // JVMs ignore transformer exceptions. Invalid class data makes this explicitly
            // instrumented fixture fail to load its writer if the checked identity is wrong.
            return new byte[0];
        }
    }

    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
