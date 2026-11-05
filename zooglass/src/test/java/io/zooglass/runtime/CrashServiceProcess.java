package io.zooglass.runtime;

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
    private final Path directory;
    private final Writer commands;
    private final LinkedBlockingQueue<String> markers = new LinkedBlockingQueue<>();
    private final StringBuffer log = new StringBuffer();
    private final Thread reader;
    private final int port;

    CrashServiceProcess(Path directory, CrashBoundaryDriver.Boundary boundary) throws Exception {
        this.directory = directory;
        String classpath =
                System.getProperty(
                        "surefire.test.class.path", System.getProperty("java.class.path"));
        Path arguments = Files.createTempFile(directory, "java-", ".args");
        Files.writeString(
                arguments,
                "-cp\n"
                        + quoted(classpath)
                        + "\n"
                        + CrashTestService.class.getName()
                        + "\n"
                        + quoted(directory.toString())
                        + "\n"
                        + boundary.name()
                        + "\n");
        String executable =
                System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        Path java = Path.of(System.getProperty("java.home"), "bin", executable);
        process =
                // These short-lived children exercise real commit boundaries and exit after a few
                // requests. Avoid spending startup CPU on higher-tier JIT compilation.
                new ProcessBuilder(java.toString(), "-XX:TieredStopAtLevel=1", "@" + arguments)
                        .redirectErrorStream(true)
                        .start();
        commands = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8);
        reader = Thread.ofPlatform().daemon().name("crash-child-output").start(this::readOutput);
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
        arm("ARM");
    }

    void armTimer() throws Exception {
        arm("ARM_TIMER");
    }

    private void arm(String command) throws Exception {
        commands.write(command + "\n");
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
        if (line == null && process.isAlive()) {
            captureThreadDump();
        }
        if (line == null || !line.startsWith(prefix)) {
            String state = process.isAlive() ? "running" : "exit " + process.exitValue();
            throw new AssertionError(
                    "Child "
                            + process.pid()
                            + " ("
                            + state
                            + ") expected "
                            + prefix
                            + ", got "
                            + line
                            + "\n"
                            + log);
        }
        return line;
    }

    // Collect the child's stacks before teardown, while a readiness stall is observable.
    private void captureThreadDump() throws InterruptedException {
        String name = System.getProperty("os.name").startsWith("Windows") ? "jcmd.exe" : "jcmd";
        Path tool = Path.of(System.getProperty("java.home"), "bin", name);
        Path dump = directory.resolve("child-" + process.pid() + "-threads.txt");
        try {
            Process diagnostic =
                    new ProcessBuilder(
                                    tool.toString(), Long.toString(process.pid()), "Thread.print")
                            .redirectErrorStream(true)
                            .redirectOutput(dump.toFile())
                            .start();
            if (!diagnostic.waitFor(3, TimeUnit.SECONDS)) {
                diagnostic.destroyForcibly();
                log.append("\nThread dump timed out");
            } else {
                log.append("\n").append(Files.readString(dump));
            }
        } catch (java.io.IOException failure) {
            log.append("\nCould not collect child stacks: ").append(failure);
        }
    }

    private void readOutput() {
        try (var input =
                new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = input.readLine()) != null; ) {
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
