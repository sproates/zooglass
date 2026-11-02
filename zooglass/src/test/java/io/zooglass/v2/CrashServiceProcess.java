package io.zooglass.v2;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Owns one child process, drains its output, and bounds every wait and cleanup. */
final class CrashServiceProcess implements AutoCloseable {
    private final Process process;
    private final Writer commands;
    private final LinkedBlockingQueue<String> markers = new LinkedBlockingQueue<>();
    private final StringBuffer log = new StringBuffer();
    private final Thread reader;
    private final int port;

    CrashServiceProcess(Path directory, CrashBoundaryDriver.Boundary boundary) throws Exception {
        String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        Path arguments = Files.createTempFile(directory, "java-", ".args");
        Files.writeString(arguments, "-cp\n" + quoted(classpath) + "\n"
                + CrashTestService.class.getName() + "\n"
                + quoted(directory.toString()) + "\n" + boundary.name() + "\n");
        String executable = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        Path java = Path.of(System.getProperty("java.home"), "bin", executable);
        process = new ProcessBuilder(java.toString(), "@" + arguments)
                .redirectErrorStream(true).start();
        commands = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8);
        reader = Thread.ofVirtual().start(this::readOutput);
        try {
            port = Integer.parseInt(await("CRASH_READY ").substring("CRASH_READY ".length()));
        } catch (Exception | AssertionError failure) {
            close();
            throw failure;
        }
    }

    int port() {
        return port;
    }

    void arm() throws Exception {
        commands.write("ARM\n");
        commands.flush();
        await("CRASH_ARMED");
    }

    void awaitBoundary(CrashBoundaryDriver.Boundary boundary) throws Exception {
        await("CRASH_BOUNDARY " + boundary.name());
    }

    void kill() throws Exception {
        process.destroyForcibly();
        if (!process.waitFor(10, TimeUnit.SECONDS)) {
            throw new AssertionError("Child did not terminate\n" + log);
        }
        reader.join(Duration.ofSeconds(5));
        if (process.exitValue() == 0) {
            throw new AssertionError("Expected abrupt termination, got a normal exit\n" + log);
        }
    }

    private String await(String prefix) throws Exception {
        String line = markers.poll(30, TimeUnit.SECONDS);
        if (line == null || !line.startsWith(prefix)) {
            throw new AssertionError("Expected " + prefix + ", got " + line + "\n" + log);
        }
        return line;
    }

    private void readOutput() {
        try (var input = new BufferedReader(new InputStreamReader(
                process.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = input.readLine()) != null;) {
                log.append(line).append('\n');
                if (line.startsWith("CRASH_")) {
                    markers.add(line);
                }
            }
        } catch (java.io.IOException failure) {
            log.append(failure.toString());
        } finally {
            markers.add("CRASH_EXIT");
        }
    }

    private static String quoted(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    @Override
    public void close() throws Exception {
        if (process.isAlive()) {
            kill();
        }
        commands.close();
        reader.join(Duration.ofSeconds(5));
    }
}
