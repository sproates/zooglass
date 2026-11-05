package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.api.ViewSnapshot;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.DefaultResourceLoader;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

class RuntimeConfigurationTests {

    @TempDir Path directory;

    @Test
    void rejectsInvalidLimitsStorageAndReferencesBeforeActivation() {
        var valid = IdentityFixtures.configuration(2, 10, 3);
        var unknownField =
                new RuntimeConfiguration.View(
                        "bad",
                        Map.of("f", new RuntimeConfiguration.Field("unknown", "p", "arrival")));
        var unknownMode =
                new RuntimeConfiguration.View(
                        "bad", Map.of("f", new RuntimeConfiguration.Field("fleet", "p", "plugin")));
        for (var invalid :
                List.of(
                        new RuntimeConfiguration(
                                1, "memory", 2, 10, 3, valid.sources(), valid.views()),
                        new RuntimeConfiguration(
                                2, "sqlite", 2, 10, 3, valid.sources(), valid.views()),
                        new RuntimeConfiguration(
                                2, "memory", 0, 10, 3, valid.sources(), valid.views()),
                        new RuntimeConfiguration(
                                2, "memory", 2, 0, 3, valid.sources(), valid.views()),
                        new RuntimeConfiguration(
                                2, "memory", 2, 10, 0, valid.sources(), valid.views()),
                        new RuntimeConfiguration(
                                2,
                                "memory",
                                2,
                                10,
                                3,
                                List.of(valid.sources().getFirst(), valid.sources().getFirst()),
                                valid.views()),
                        new RuntimeConfiguration(
                                2,
                                "memory",
                                2,
                                10,
                                3,
                                valid.sources(),
                                List.of(valid.views().getFirst(), valid.views().getFirst())),
                        new RuntimeConfiguration(
                                2, "memory", 2, 10, 3, valid.sources(), List.of(unknownField)),
                        new RuntimeConfiguration(
                                2, "memory", 2, 10, 3, valid.sources(), List.of(unknownMode)))) {
            assertThatThrownBy(() -> new ViewCoordinator(invalid))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void resourceParsingRejectsUnknownPropertiesCoercionsAndDuplicateKeys() throws Exception {
        String valid = Files.readString(Path.of("src/test/resources/runtime-views-test.json"));
        Path file = directory.resolve("config.json");
        Files.writeString(file, valid);
        assertThat(load(file).contractVersion()).isEqualTo(2);
        for (String invalid :
                new String[] {
                    "null",
                    "{}",
                    "{",
                    valid + " {}",
                    valid.replace("\"contractVersion\": 2", "\"contractVersion\": \"2\""),
                    valid.replace("\"maxStreams\": 5", "\"maxStreams\": 5.2"),
                    valid.replace(
                            "\"storage\": \"memory\"", "\"storage\": \"memory\", \"plugin\": true"),
                    valid.replace(
                            "\"epoch\": \"trip-1\"",
                            "\"epoch\": \"trip-1\", \"epoch\": \"trip-2\""),
                }) {
            Files.writeString(file, invalid);
            assertThatThrownBy(() -> load(file)).isInstanceOf(RuntimeException.class);
        }
        assertThatThrownBy(() -> load(directory.resolve("absent.json")))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void runtimeDefinitionsUseTheSameStrictGrammarAndAllowDistinctTypesFromOneSource() {
        var valid =
                """
                {"id":"combined","fields":{"position":{"inputs":[
                  {"sourceId":"fleet","type":"position"},
                  {"sourceId":"fleet","type":"corrected"}],"mode":"arrival"}}}
                """;
        var definition = RuntimeConfiguration.parseView(valid);
        try (var runtime = new ViewCoordinator(IdentityFixtures.configuration(10, 100, 100))) {
            assertThat(runtime.define(definition)).isTrue();
            runtime.apply(IdentityFixtures.event(1));
            runtime.apply(
                    IdentityFixtures.parse(
                            "fleet", "trip-1", "car", 2, "corrected", "{\"value\":2}"));
            assertThat(
                            ViewSnapshot.from(runtime.snapshot("combined", "car").orElseThrow())
                                    .data()
                                    .get("position")
                                    .path("value")
                                    .intValue())
                    .isEqualTo(2);
        }
        for (String invalid :
                List.of(
                        "null",
                        "[]",
                        valid + " {}",
                        valid.replace("\"combined\"", "42"),
                        valid.replace(
                                "\"mode\":\"arrival\"", "\"mode\":\"arrival\",\"unknown\":true"),
                        valid.replace(
                                "\"id\":\"combined\"",
                                "\"id\":\"combined\",\"id\":\"duplicate\""))) {
            assertThatThrownBy(() -> RuntimeConfiguration.parseView(invalid))
                    .isInstanceOf(RuntimeException.class);
        }
    }

    private RuntimeConfiguration load(Path path) {
        return RuntimeConfiguration.load(new DefaultResourceLoader(), path.toUri().toString());
    }
}
