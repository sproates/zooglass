package io.zooglass.config;

import io.zooglass.runtime.ConfigurationInspection;
import io.zooglass.runtime.ConfigurationInspection.Diagnostic;

import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
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
            ConfigurationExplanation.Explanation explanation) {}

    private ConfigurationCommand() {}

    public static int run(String[] args, PrintStream output) {
        boolean json = List.of(args).contains("--json");
        String operation = args.length > 1 ? args[1] : null;
        if (args.length < 3 || args.length > 4 || !"config".equals(args[0])
                || !("check".equals(operation) || "explain".equals(operation))
                || args[2].startsWith("--") || (args.length == 4 && !"--json".equals(args[3]))) {
            emit(output, json, failed(operation, "usage", "Usage: config check|explain FILE [--json]"));
            return 2;
        }

        Report report;
        try {
            var path = Path.of(args[2]);
            if (!Files.isRegularFile(path)) {
                throw new IOException("Input must be a regular file");
            }
            byte[] bytes;
            try (var input = Files.newInputStream(path)) {
                bytes = input.readNBytes(MAX_INPUT_BYTES + 1);
            }
            if (bytes.length > MAX_INPUT_BYTES) {
                emit(output, json, failed(operation, "input-too-large", "Input exceeds the 16 MiB tool limit"));
                return 1;
            }
            var decoder = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            var inspection = ConfigurationInspection.inspect(decoder.decode(ByteBuffer.wrap(bytes)).toString());
            report = inspection.valid()
                    ? new Report("zooglass-config-report/v1", operation, "runtime/v2", true,
                            inspection.configuration().storage(), NOT_CHECKED, List.of(),
                            "explain".equals(operation) ? ConfigurationExplanation.explain(inspection) : null)
                    : new Report("zooglass-config-report/v1", operation, null, false,
                            null, NOT_CHECKED, List.of(inspection.diagnostic()), null);
        } catch (CharacterCodingException failure) {
            report = failed(operation, "invalid-encoding", "Input must be valid UTF-8");
        } catch (IOException | InvalidPathException | SecurityException failure) {
            report = failed(operation, "input-io", "Cannot read the input as a regular file");
        }
        emit(output, json, report);
        return output.checkError() ? 1 : report.valid() ? 0 : 1;
    }

    private static Report failed(String operation, String code, String reason) {
        return new Report("zooglass-config-report/v1", operation, null, false, null,
                NOT_CHECKED, List.of(new Diagnostic(code, "", reason, null, null)), null);
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
            return;
        }
        output.println("Valid runtime v2 configuration; storage: " + report.storage());
        output.println("Not checked: deployment, existing-database compatibility, timeline eligibility.");
        if (report.explanation() != null) {
            output.println("Effective settings (normalised by production decoding):");
            output.println(MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(report.explanation().effective()));
            output.println("Defaults applied (JSON pointers into effective settings):");
            for (var value : report.explanation().defaults()) {
                output.println("  " + value.path() + " = " + MAPPER.writeValueAsString(value.value()));
            }
        }
    }
}
