package io.zooglass.runtime;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/** Run an unchanged capture oracle with the packaged class, then each single-class test override. */
class PostgresFenceControlsIT {
    private static final Path TARGET = Path.of("target").toAbsolutePath().normalize();
    private static final Path CONTROLS = TARGET.resolve("ha-fence-controls");
    @TempDir Path logs;

    @Test
    @Timeout(180)
    void onlyTheCorrespondingCaptureInvariantFailsForEachPreparedOverride() throws Exception {
        var resultPath = CONTROLS.resolve("results.json");
        Files.deleteIfExists(resultPath);
        // Also defend direct surefire:test invocation. Verification never performs preparation.
        var preflight = logs.resolve("preparation-verification.log");
        var verify = new ProcessBuilder("python3", "scripts/prepare-ha-controls.py", "--verify")
                .redirectErrorStream(true).redirectOutput(preflight.toFile()).start();
        int status = waitFor(verify, 15);
        assertThat(status).as("control provenance verification: %s", Files.readString(preflight)).isZero();
        var manifest = StateRowJson.JSON.readTree(Files.readString(CONTROLS.resolve("manifest.json")));
        var results = StateRowJson.JSON.createObjectNode();
        results.put("serviceJarSha256", manifest.path("serviceJarSha256").asText());
        results.put("runtimeJarSha256", manifest.path("runtimeJarSha256").asText());
        var runs = results.putArray("runs");
        for (String variant : List.of("production", "capture-owner", "capture-revision")) {
            for (String scenario : List.of("owner", "revision")) {
                var observation = exercise(variant, scenario, manifest);
                var run = runs.addObject();
                run.put("variant", variant);
                run.set("observation", observation);
            }
        }
        var staging = CONTROLS.resolve("results.pending");
        Files.writeString(staging, StateRowJson.JSON.writerWithDefaultPrettyPrinter().writeValueAsString(results) + "\n");
        Files.move(staging, resultPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    private JsonNode exercise(String variant, String scenario, JsonNode manifest) throws Exception {
        boolean shouldFail = variant.equals("capture-" + scenario);
        var log = logs.resolve(variant + "-" + scenario + ".log");
        var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", childClasspath(variant), PostgresFenceScenario.class.getName(), scenario)
                .redirectErrorStream(true).redirectOutput(log.toFile()).start();
        int status = waitFor(process, 20);
        String output = Files.readString(log);
        // Infrastructure, precondition and cleanup failures never satisfy the negative control.
        assertThat(status).as("%s/%s: %s", variant, scenario, output)
                .isEqualTo(shouldFail ? PostgresFenceScenario.INVARIANT_FAILURE : 0);
        var markers = output.lines().filter(line -> line.startsWith(PostgresFenceScenario.PREFIX)).toList();
        assertThat(markers).hasSize(1);
        var observed = StateRowJson.JSON.readTree(markers.getFirst().substring(PostgresFenceScenario.PREFIX.length()));
        var sha = variant.equals("production") ? manifest.path("authoritySha256")
                : manifest.path("controls").path(variant).path("classSha256");
        assertThat(observed.path("classSha256")).isEqualTo(sha);
        assertThat(observed.path("scenario").asText()).isEqualTo(scenario);
        assertThat(observed.path("invariant").asText()).isEqualTo(scenario.equals("owner")
                ? "former-owner-capture-refused" : "stale-cache-capture-refused");
        assertThat(observed.path("invariantPassed").isBoolean()).isTrue();
        assertThat(observed.path("invariantPassed").asBoolean()).isEqualTo(!shouldFail);
        assertThat(observed.path("captureResult").asText()).isEqualTo(shouldFail ? "accepted" : "refused");
        return observed;
    }

    private String childClasspath(String variant) {
        var cp = new ArrayList<String>();
        if (!variant.equals("production")) cp.add(CONTROLS.resolve(variant).toString());
        cp.add(TARGET.resolve("zooglass-runtime.jar").toString());
        cp.add(TARGET.resolve("test-classes").toString());
        String dependencies = System.getProperty("surefire.test.class.path");
        if (dependencies == null) throw new IllegalStateException("Missing prepared Surefire dependency classpath");
        Arrays.stream(dependencies.split(Pattern.quote(File.pathSeparator)))
                .filter(entry -> entry.endsWith(".jar")).filter(entry -> !Path.of(entry).toAbsolutePath().startsWith(TARGET))
                .forEach(cp::add);
        return String.join(File.pathSeparator, cp);
    }

    private static int waitFor(Process child, int seconds) throws Exception {
        try {
            if (!child.waitFor(seconds, TimeUnit.SECONDS)) throw new IllegalStateException("Timed out waiting for control child");
            return child.exitValue();
        } finally {
            if (child.isAlive()) {
                child.destroyForcibly();
                if (!child.waitFor(5, TimeUnit.SECONDS)) throw new IllegalStateException("Control child did not exit");
            }
        }
    }
}
