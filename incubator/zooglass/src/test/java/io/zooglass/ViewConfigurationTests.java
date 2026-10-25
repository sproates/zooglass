package io.zooglass;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.DefaultResourceLoader;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ViewConfigurationTests {
    private final JsonMapper mapper = JsonMapper.builder().build();
    @TempDir Path directory;

    @Test
    void missingResourceReportsItsLocationAndCause() {
        String location = directory.resolve("missing.json").toUri().toString();
        assertThatThrownBy(() -> load(location)).isInstanceOf(IllegalStateException.class)
                .hasMessage("Could not load view configuration from " + location)
                .hasCauseInstanceOf(java.io.IOException.class);
    }

    @Test
    void loadsDefinitionsFromAResourceAndRejectsMalformedJson() throws Exception {
        Path file = directory.resolve("views.json");
        Files.writeString(file, "{\"views\":[" + validDefinition() + "]}");
        assertThat(load(file.toUri().toString()).containsView("positions")).isTrue();
        Files.writeString(file, "{broken");
        assertThatThrownBy(() -> load(file.toUri().toString()))
                .isInstanceOf(tools.jackson.core.JacksonException.class);
    }

    @TestFactory
    Stream<DynamicTest> startupRejectsInvalidConfigurationsWithUsefulMessages() {
        record Invalid(String json, String message) {}
        return List.of(
                new Invalid("null", "must contain a views array"),
                new Invalid("{}", "must contain a views array"),
                new Invalid("{\"views\":[null]}", "empty view definition"),
                new Invalid("{\"views\":[" + validDefinition() + "," + validDefinition() + "]}",
                        "configured more than once: positions"),
                new Invalid("{\"views\":[{\"id\":\" \"}]}", "non-empty view id"),
                new Invalid("{\"views\":[{\"id\":\"positions\",\"fields\":{}}]}", "at least one field")
        ).stream().map(invalid -> DynamicTest.dynamicTest(invalid.message(), () -> {
            ViewConfiguration configuration = mapper.readValue(invalid.json(), ViewConfiguration.class);
            assertThatThrownBy(() -> new ViewStore(configuration))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining(invalid.message());
        }));
    }

    @Test
    void invalidRuntimeDefinitionDoesNotReserveItsIdOrRegisterMatchers() throws Exception {
        ViewStore store = new ViewStore(new ViewConfiguration(List.of()));
        String invalid = validDefinition().replace("\"type\":\"position\"", "\"type\":\" \"");
        assertThatThrownBy(() -> store.define(mapper.readValue(invalid, ViewConfiguration.ViewDefinition.class)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("non-empty type");
        assertThat(store.containsView("positions")).isFalse();
        assertThat(store.apply("feed", "position", "entity", mapper.readTree("{\"sequence\":1}"))).isEmpty();
        assertThat(store.define(mapper.readValue(validDefinition(), ViewConfiguration.ViewDefinition.class))).isTrue();
        assertThat(store.define(mapper.readValue(validDefinition(), ViewConfiguration.ViewDefinition.class))).isFalse();
        assertThat(store.apply("feed", "position", "entity", mapper.readTree("{\"sequence\":1}"))).hasSize(1);
    }

    @TestFactory
    Stream<DynamicTest> runtimeValidationRejectsMalformedFieldsAndOrdering() {
        record Invalid(String definition, String message) {}
        return List.of(
                new Invalid("null", "JSON object"),
                new Invalid("{\"id\":\"positions\"}", "at least one field"),
                new Invalid("{\"id\":\"positions\",\"fields\":{\" \":[]}}", "non-empty field name"),
                new Invalid("{\"id\":\"positions\",\"fields\":{\"position\":null}}", "at least one event matcher"),
                new Invalid("{\"id\":\"positions\",\"fields\":{\"position\":[]}}", "at least one event matcher"),
                new Invalid("{\"id\":\"positions\",\"fields\":{\"position\":[null]}}", "empty event matcher"),
                new Invalid(validDefinition().replace("\"feed\"", "null"), "non-empty sourceId"),
                new Invalid(withOrdering("{\"unknown\":null}"), "unknown view field"),
                new Invalid(withOrdering("{\"position\":null}"), "unsupported ordering mode"),
                new Invalid(withOrdering("{\"position\":{\"mode\":\"other\"}}"), "unsupported ordering mode"),
                new Invalid(withOrdering("{\"position\":{\"mode\":\"latestBySequence\",\"sequenceField\":\" \"}}"), "non-empty sequenceField")
        ).stream().map(invalid -> DynamicTest.dynamicTest(invalid.message(), () -> {
            ViewStore store = new ViewStore(new ViewConfiguration(List.of()));
            var definition = mapper.readValue(invalid.definition(), ViewConfiguration.ViewDefinition.class);
            assertThatThrownBy(() -> store.define(definition))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining(invalid.message());
            assertThat(store.containsView("positions")).isFalse();
        }));
    }

    private static String withOrdering(String ordering) {
        return """
                {"id":"positions","fields":{"position":[{"sourceId":"feed","type":"position"}]},
                 "ordering":%s}
                """.formatted(ordering);
    }

    private ViewStore load(String location) {
        return new ViewStore(mapper, new DefaultResourceLoader(), location);
    }

    private static String validDefinition() {
        return """
                {"id":"positions","fields":{"position":[{"sourceId":"feed","type":"position"}]}}
                """;
    }
}
