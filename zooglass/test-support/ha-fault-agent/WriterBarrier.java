package io.zooglass.testagent;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.TimeUnit;

/** One-shot, bounded file coordination for a single viewer in an explicitly instrumented fixture JVM. */
public final class WriterBarrier {
    private static Path directory;
    private WriterBarrier() {}

    static void initialise(Path location) throws IOException {
        if (!location.isAbsolute() || !Files.isDirectory(location, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Expected an existing absolute barrier directory");
        }
        directory = location.toRealPath();
        if (Files.exists(directory.resolve("agent.installed"))) throw new IOException("Use a fresh per-process barrier directory");
    }

    static void marker(String name, String value) throws IOException {
        Path target = directory.resolve(name);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Duplicate barrier marker");
        Path tmp = Files.createTempFile(directory, ".gate-", ".tmp");
        try {
            Files.writeString(tmp, value + "\n", StandardOpenOption.TRUNCATE_EXISTING);
            Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    public static void before(URI socket) { if (viewer(socket)) hold("before"); }
    public static void after(URI socket) { if (viewer(socket)) hold("after"); }
    public static void writeBefore() { hold("write-before"); }
    public static void writeLocked() { hold("write-locked"); }

    private static boolean viewer(URI socket) {
        return socket != null && "/views/live".equals(socket.getPath());
    }

    private static synchronized String claim(String stage) throws IOException {
        Path arm = directory.resolve(stage + ".arm");
        if (!Files.isRegularFile(arm, LinkOption.NOFOLLOW_LINKS)) return null;
        String token;
        try (var input = Files.newInputStream(arm, LinkOption.NOFOLLOW_LINKS)) {
            byte[] bytes = input.readNBytes(67);
            if (bytes.length == 67) throw new IOException("Oversized barrier arm");
            token = new String(bytes, StandardCharsets.US_ASCII).strip();
        }
        if (!token.matches("[A-Za-z0-9-]{1,64}")) throw new IOException("Invalid barrier token");
        Files.delete(arm);
        String prefix = stage + "-" + token;
        if (Files.exists(directory.resolve(prefix + ".release"), LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Barrier release preceded its observation");
        }
        marker(prefix + ".reached", token);
        return prefix;
    }

    private static void hold(String stage) {
        try {
            String prefix = claim(stage);
            if (prefix == null) return;
            long started = System.nanoTime();
            Path release = directory.resolve(prefix + ".release");
            while (System.nanoTime() - started < TimeUnit.SECONDS.toNanos(20)) {
                if (Files.isRegularFile(release, LinkOption.NOFOLLOW_LINKS)) {
                    marker(prefix + ".resumed", "released");
                    return;
                }
                try {
                    Thread.sleep(5);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    marker(prefix + ".interrupted", "writer retired");
                    throw new IllegalStateException("Fault fixture writer was retired", interrupted);
                }
            }
            marker(prefix + ".expired", "deadline");
            throw new IllegalStateException("Fault fixture writer barrier expired");
        } catch (IOException failure) {
            throw new IllegalStateException("Fault fixture barrier I/O failed", failure);
        }
    }
}
