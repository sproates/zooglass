package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;

import java.util.Map;

class LegacySettingsTests {
    @ParameterizedTest
    @ValueSource(strings = {"config", "database"})
    void refusesRetiredSettingsBeforeOpeningDefaultStorage(String setting) {
        String legacy = "zooglass.v2." + setting;
        try (var context = new AnnotationConfigApplicationContext()) {
            context.getEnvironment()
                    .getPropertySources()
                    .addFirst(new MapPropertySource("deployment", Map.of(legacy, "old-setting")));
            context.register(ViewCoordinator.class);
            Throwable failure = org.assertj.core.api.Assertions.catchThrowable(context::refresh);
            assertThat(failure)
                    .isNotNull()
                    .hasRootCauseMessage("Replace " + legacy + " with zooglass." + setting);
        }
    }
}
