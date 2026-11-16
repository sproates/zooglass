package io.zooglass.config;

import com.fasterxml.jackson.annotation.JsonInclude;

import io.zooglass.runtime.ConfigurationInspection;
import io.zooglass.runtime.ConfigurationInspection.Diagnostic;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.List;

/** Offline inspection dispatch. No application context, runtime or storage is constructed. */
public final class ConfigurationCommand {
    static final int MAX_INPUT_BYTES = 16 * 1024 * 1024;
    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    private static final List<String> NOT_CHECKED =
            List.of("deployment", "existingDatabaseCompatibility", "timelineEligibility");

    record Report(
            String format, String operation, String inputFormat, boolean valid,
            String storage, List<String> notChecked, List<Diagnostic> diagnostics,
            ConfigurationExplanation.Explanation explanation,
            @JsonInclude(JsonInclude.Include.NON_NULL) List<ConfigurationAuthoring.Origin> origins,
            @JsonInclude(JsonInclude.Include.NON_NULL) ExpansionOutput.Metadata expansion) {}

    record Prepared(String inputFormat, ConfigurationInspection.Result inspection,
            List<ConfigurationAuthoring.Origin> origins, byte[] expanded) {}

    private ConfigurationCommand() {}

    public static int run(String[] args, PrintStream output) {
        boolean json = List.of(args).contains("--json");
        String operation = args.length > 1 ? args[1] : null;
        if (!validArguments(args, operation)) {
            emit(output, json, failed(operation, "usage", "",
                    "Usage: config check|explain FILE [--json]; config expand FILE --output NEW_FILE [--json]"));
            return 2;
        }
        ExpansionOutput.CreatedFile created = null;
        Report report;
        try {
            byte[] input = readInput(Path.of(args[2]));
            if (input.length > MAX_INPUT_BYTES) {
                emit(output, json, failed(operation, "input-too-large", "", "Input exceeds the 16 MiB tool limit"));
                return 1;
            }
            var decoder = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            var prepared = prepare(decoder.decode(ByteBuffer.wrap(input)).toString());
            var inspection = prepared.inspection();
            ExpansionOutput.Metadata metadata = null;
            if (inspection.valid() && "expand".equals(operation)) {
                if (prepared.expanded() == null) {
                    emit(output, json, failed(operation, "authoring-required", "", "Expand requires authored input"));
                    return 1;
                }
                metadata = ExpansionOutput.metadata(input, prepared.expanded());
                var destination = Path.of(args[4]);
                created = ExpansionOutput.writeNew(destination, prepared.expanded());
            }
            report = new Report("zooglass-config-report/v1", operation,
                    inspection.valid() ? prepared.inputFormat() : null, inspection.valid(),
                    inspection.valid() ? inspection.configuration().storage() : null,
                    NOT_CHECKED, inspection.valid() ? List.of() : List.of(inspection.diagnostic()),
                    inspection.valid() && "explain".equals(operation)
                            ? ConfigurationExplanation.explain(inspection) : null,
                    prepared.origins(), metadata);
        } catch (ConfigurationAuthoring.Invalid failure) {
            report = failed(operation, "invalid-authoring", failure.path, failure.getMessage());
        } catch (ExpansionOutput.TooLarge failure) {
            report = failed(operation, "expanded-too-large", "", "Expanded output exceeds the 16 MiB tool limit");
        } catch (CharacterCodingException failure) {
            report = failed(operation, "invalid-encoding", "", "Input must be valid UTF-8");
        } catch (FileAlreadyExistsException failure) {
            report = failed(operation, "output-exists", "", "Output must be a new file");
        } catch (IOException | InvalidPathException | SecurityException failure) {
            report = "expand".equals(operation)
                    ? failed(operation, "expansion-io", "", "Cannot read input, identify the prepared JAR or write new output")
                    : failed(operation, "input-io", "", "Cannot read the input as a regular file");
        }
        return finish(output, json, report, created);
    }

    static int finish(PrintStream output, boolean json, Report report, ExpansionOutput.CreatedFile created) {
        boolean succeeded = false;
        try {
            emit(output, json, report);
            succeeded = !output.checkError() && report.valid();
            return succeeded ? 0 : 1;
        } catch (RuntimeException failedReport) {
            return 1;
        } finally {
            if (!succeeded && created != null) {
                try { created.discard(); }
                catch (IOException | RuntimeException ignored) {
                    // A failed cleanup must not turn an unsuccessful command into success.
                }
            }
        }
    }

    private static boolean validArguments(String[] args, String operation) {
        if (args.length < 3 || !"config".equals(args[0]) || args[2].startsWith("--")) return false;
        if ("expand".equals(operation)) {
            return (args.length == 5 || args.length == 6 && "--json".equals(args[5]))
                    && "--output".equals(args[3]) && !args[4].startsWith("--");
        }
        return ("check".equals(operation) || "explain".equals(operation))
                && (args.length == 3 || args.length == 4 && "--json".equals(args[3]));
    }

    private static byte[] readInput(Path path) throws IOException {
        if (!Files.isRegularFile(path)) throw new IOException("Input must be a regular file");
        try (var input = Files.newInputStream(path)) {
            return input.readNBytes(MAX_INPUT_BYTES + 1);
        }
    }

    private static Prepared prepare(String text) {
        tools.jackson.databind.JsonNode source;
        try {
            source = ConfigurationInspection.readDocument(text);
        } catch (JacksonException | IllegalArgumentException failure) {
            return new Prepared(null, ConfigurationInspection.inspect(text), null, null);
        }
        if (source == null || !source.has("format")) {
            return new Prepared("runtime/v2", ConfigurationInspection.inspect(source), null, null);
        }
        var resolved = ConfigurationAuthoring.resolve(source);
        byte[] expanded = ExpansionOutput.encode(resolved);
        var inspection = ConfigurationInspection.inspect(new String(expanded, StandardCharsets.UTF_8));
        var origins = inspection.valid() ? resolved.origins()
                : resolved.origins().stream().filter(origin ->
                        inspection.diagnostic().path().equals(origin.path())
                        || inspection.diagnostic().path().startsWith(origin.path() + "/")).toList();
        return new Prepared(ConfigurationAuthoring.FORMAT, inspection, origins, expanded);
    }

    private static Report failed(String operation, String code, String path, String reason) {
        return new Report("zooglass-config-report/v1", operation, null, false, null,
                NOT_CHECKED, List.of(new Diagnostic(code, path, reason, null, null)), null, null, null);
    }

    private static void emit(PrintStream output, boolean json, Report report) {
        if (json) {
            output.println(MAPPER.writeValueAsString(report));
            return;
        }
        if (!report.valid()) {
            for (var diagnostic : report.diagnostics()) {
                output.println(diagnostic.code() + " at "
                        + (diagnostic.path().isEmpty() ? "document root" : diagnostic.path())
                        + ": " + diagnostic.reason()
                        + (diagnostic.line() == null ? "" : " (line " + diagnostic.line()
                                + ", column " + diagnostic.column() + ")"));
            }
        } else {
            output.println("Valid " + report.inputFormat() + " configuration; storage: " + report.storage());
            output.println("Not checked: deployment, existing-database compatibility, timeline eligibility.");
        }
        if (report.explanation() != null) {
            output.println("Effective settings (normalised by production decoding):");
            output.println(MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(report.explanation().effective()));
            output.println("Defaults applied (JSON pointers into effective settings):");
            for (var value : report.explanation().defaults()) {
                output.println("  " + value.path() + " = " + MAPPER.writeValueAsString(value.value()));
            }
        }
        if (report.origins() != null) {
            for (var origin : report.origins()) {
                output.println(origin.path() + " uses " + origin.templatePath() + " via " + origin.usePath());
            }
        }
        if (report.expansion() != null) {
            output.println("Expansion identity: " + MAPPER.writeValueAsString(report.expansion()));
        }
    }
}
