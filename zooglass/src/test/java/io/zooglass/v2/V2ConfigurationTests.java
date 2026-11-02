package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.DefaultResourceLoader;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class V2ConfigurationTests {
    @TempDir
    Path directory;

    @Test
    void rejectsInvalidLimitsStorageAndReferencesBeforeActivation() {
        var valid = IdentityFixtures.configuration(2, 10, 3);
        var unknownField = new V2Configuration.View("bad", Map.of("f", new V2Configuration.Field("unknown", "p", "arrival")));
        var unknownMode = new V2Configuration.View("bad", Map.of("f", new V2Configuration.Field("fleet", "p", "plugin")));
        for (var invalid : List.of(
                new V2Configuration(1, "memory", 2, 10, 3, valid.sources(), valid.views()),
                new V2Configuration(2, "sqlite", 2, 10, 3, valid.sources(), valid.views()),
                new V2Configuration(2, "memory", 0, 10, 3, valid.sources(), valid.views()),
                new V2Configuration(2, "memory", 2, 0, 3, valid.sources(), valid.views()),
                new V2Configuration(2, "memory", 2, 10, 0, valid.sources(), valid.views()),
                new V2Configuration(2, "memory", 2, 10, 3, List.of(valid.sources().getFirst(), valid.sources().getFirst()), valid.views()),
                new V2Configuration(2, "memory", 2, 10, 3, valid.sources(), List.of(valid.views().getFirst(), valid.views().getFirst())),
                new V2Configuration(2, "memory", 2, 10, 3, valid.sources(), List.of(unknownField)),
                new V2Configuration(2, "memory", 2, 10, 3, valid.sources(), List.of(unknownMode)))) {
            assertThatThrownBy(() -> new ViewCoordinator(invalid)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void resourceParsingRejectsUnknownPropertiesCoercionsAndDuplicateKeys() throws Exception {
        String valid = Files.readString(Path.of("src/test/resources/v2-views-test.json"));
        Path file = directory.resolve("config.json");
        Files.writeString(file, valid);
        assertThat(load(file).contractVersion()).isEqualTo(2);
        for (String invalid : new String[] {"null", "{}", "{", valid + " {}",
                valid.replace("\"contractVersion\": 2", "\"contractVersion\": \"2\""),
                valid.replace("\"maxStreams\": 5", "\"maxStreams\": 5.2"),
                valid.replace("\"storage\": \"memory\"", "\"storage\": \"memory\", \"plugin\": true"),
                valid.replace("\"epoch\": \"trip-1\"", "\"epoch\": \"trip-1\", \"epoch\": \"trip-2\"")}) {
            Files.writeString(file, invalid);
            assertThatThrownBy(() -> load(file)).isInstanceOf(RuntimeException.class);
        }
        assertThatThrownBy(() -> load(directory.resolve("absent.json"))).isInstanceOf(IllegalStateException.class);
    }

    private V2Configuration load(Path path) {
        return V2Configuration.load(new DefaultResourceLoader(), path.toUri().toString());
    }
}
