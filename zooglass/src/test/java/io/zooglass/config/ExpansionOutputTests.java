package io.zooglass.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;

class ExpansionOutputTests {
    @TempDir Path directory;

    private final byte[] contents = "runtime output\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    @Test
    void existingOutputIsNeverAcquiredOrRemoved() throws Exception {
        Path destination = directory.resolve("runtime.json");
        Files.writeString(destination, "existing data");

        assertThatThrownBy(() -> ExpansionOutput.writeNew(destination, contents))
                .isInstanceOf(java.nio.file.FileAlreadyExistsException.class);

        assertThat(Files.readString(destination)).isEqualTo("existing data");
    }

    @Test
    void writeAndCloseFailuresRemoveTheOwnedPartialOutput() throws Exception {
        for (boolean failOnClose : List.of(false, true)) {
            Path destination = directory.resolve("runtime.json");
            assertThatThrownBy(() -> ExpansionOutput.writeNew(destination, contents, path -> {
                var file = Files.newOutputStream(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
                return new FilterOutputStream(file) {
                    @Override
                    public void write(byte[] bytes) throws IOException {
                        if (failOnClose) {
                            out.write(bytes);
                        } else {
                            out.write(bytes[0]);
                            throw new IOException("injected write failure");
                        }
                    }

                    @Override
                    public void close() throws IOException {
                        super.close();
                        if (failOnClose) throw new IOException("injected close failure");
                    }
                };
            })).isInstanceOf(IOException.class)
                    .hasMessage(failOnClose ? "injected close failure" : "injected write failure");
            assertThat(destination).doesNotExist();
        }
    }

    @Test
    void failedReportRemovesOwnedOutputWhetherTheStreamFlagsOrThrowsFailure() throws Exception {
        for (boolean throwFailure : List.of(false, true)) {
            Path destination = directory.resolve("runtime.json");
            var created = ExpansionOutput.writeNew(destination, contents);
            try (var report = new PrintStream(OutputStream.nullOutputStream()) {
                @Override
                public void println(String value) {
                    if (throwFailure) throw new UncheckedIOException(new IOException("report failed"));
                    setError();
                }
            }) {
                assertThat(ConfigurationCommand.finish(report, true, validReport(), created)).isEqualTo(1);
            }
            assertThat(destination).doesNotExist();
        }
    }

    @Test
    void failedReportPreservesAnotherFileMovedToTheDestination() throws Exception {
        Path destination = directory.resolve("runtime.json");
        Path moved = directory.resolve("original.json");
        var created = ExpansionOutput.writeNew(destination, contents);
        try (var report = new PrintStream(OutputStream.nullOutputStream()) {
            @Override
            public void println(String value) {
                try {
                    Files.move(destination, moved);
                    Files.writeString(destination, "replacement data");
                } catch (IOException failure) {
                    throw new UncheckedIOException(failure);
                }
                setError();
            }
        }) {
            assertThat(ConfigurationCommand.finish(report, true, validReport(), created)).isEqualTo(1);
        }
        assertThat(Files.readString(destination)).isEqualTo("replacement data");
        assertThat(Files.readAllBytes(moved)).isEqualTo(contents);
    }

    @Test
    void successfulReportKeepsTheCompleteOutput() throws Exception {
        Path destination = directory.resolve("runtime.json");
        var created = ExpansionOutput.writeNew(destination, contents);
        try (var report = new PrintStream(OutputStream.nullOutputStream())) {
            assertThat(ConfigurationCommand.finish(report, true, validReport(), created)).isZero();
        }
        assertThat(Files.readAllBytes(destination)).isEqualTo(contents);
    }

    private static ConfigurationCommand.Report validReport() {
        return new ConfigurationCommand.Report("zooglass-config-report/v1", "expand",
                ConfigurationAuthoring.FORMAT, true, "sqlite", List.of(), List.of(), null, null, null);
    }
}
