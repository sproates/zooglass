package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

class ConfigurationInspectionTests {
    @Test
    void agreesWithProductionParserForValidAndInvalidConfigurations() throws Exception {
        String valid = Files.readString(Path.of("docs/examples/configuration/sales-sqlite.json"));
        var cases = List.of(
                valid,
                valid.replace("sqlite", "memory"),
                valid.replace("\"latestFactRevision\"", "\"unknown\""),
                valid.replace("\"activeFacts\"", "\"arrival\""),
                valid.replace("\"contractVersion\": 2", "\"contractVersion\": \"2\""),
                valid.replace("\"contractVersion\": 2", "\"contractVersion\": 2, \"contractVersion\": 2"),
                valid.replace("\"maxStreams\": 100", "\"maxStreams\": 0"),
                valid.replace("\"fields\": {", "\"fields\": {\"null-field\":null,"),
                valid.replace("\"sales\"", "\"bad\\ud800\""),
                valid + " {}", "{}", "null", "", "[]");
        for (String json : cases) {
            RuntimeConfiguration configuration = null;
            try {
                configuration = RuntimeConfiguration.parseConfiguration(json);
            } catch (RuntimeException expectedInvalidInput) {
                // Compare acceptance, not exception type or presentation.
            }
            var inspected = ConfigurationInspection.inspect(json);
            assertThat(inspected.valid()).as(json).isEqualTo(configuration != null);
            assertThat(inspected.configuration()).isEqualTo(configuration);
            assertThat(inspected.diagnostic() == null).isEqualTo(inspected.valid());
        }
    }

    @Test
    void malformedViewObjectsStillHaveRealDiagnosticPointers() {
        var result = ConfigurationInspection.inspect(
                "{\"views\":{\"odd/~\":{\"fields\":{\"f\":{\"facts\":null}}}}}");
        assertThat(result.valid()).isFalse();
        assertThat(result.diagnostic().path()).isEqualTo("/views/odd~1~0/fields/f");
    }

    @Test
    void runtimeParserStillRejectsAuthoredInput() throws Exception {
        String authored = Files.readString(Path.of("docs/examples/configuration/sales.authored.json"));
        assertThat(ConfigurationInspection.inspect(authored).valid()).isFalse();
        org.assertj.core.api.Assertions.assertThatThrownBy(
                () -> RuntimeConfiguration.parseConfiguration(authored))
                .isInstanceOf(RuntimeException.class);
    }

    @Test
    void semanticReasonIsPreservedWithoutChangingExistingValidation() throws Exception {
        String json = Files.readString(Path.of("docs/examples/configuration/sales-sqlite.json"))
                .replace("\"activeFacts\"", "\"arrival\"");
        var result = ConfigurationInspection.inspect(json);
        assertThat(result.diagnostic().code()).isEqualTo("invalid-configuration");
        assertThat(result.diagnostic().path()).isEqualTo("/views/0/fields/items");
        assertThat(result.diagnostic().reason()).isEqualTo("Fact settings require a fact projection");
    }
}
