package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.SystemEnvironmentPropertySource;

import java.util.Map;

class LegacySettingsTests {
    @ParameterizedTest
    @ValueSource(strings = {"zooglass.views.config", "ZOOGLASS_VIEWS_CONFIG"})
    void rejectsOriginalViewConfiguration(String key) {
        try (var context = new AnnotationConfigApplicationContext()) {
            var values = Map.<String, Object>of(key, "file:/previous/views.json");
            var source =
                    key.startsWith("ZOOGLASS")
                            ? new SystemEnvironmentPropertySource("env", values)
                            : new MapPropertySource("deployment", values);
            context.getEnvironment().getPropertySources().addFirst(source);
            context.register(io.zooglass.access.AdmissionAccess.class, ViewCoordinator.class);
            assertThat(catchThrowable(context::refresh))
                    .hasRootCauseMessage(
                            "Migrate the view definitions from zooglass.views.config to a runtime"
                                + " configuration and set zooglass.config");
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"config", "database"})
    void refusesRetiredSettingsBeforeOpeningDefaultStorage(String setting) {
        String legacy = "zooglass.v2." + setting;
        try (var context = new AnnotationConfigApplicationContext()) {
            context.getEnvironment()
                    .getPropertySources()
                    .addFirst(new MapPropertySource("deployment", Map.of(legacy, "old-setting")));
            context.register(io.zooglass.access.AdmissionAccess.class, ViewCoordinator.class);
            Throwable failure = catchThrowable(context::refresh);
            assertThat(failure)
                    .isNotNull()
                    .hasRootCauseMessage("Replace " + legacy + " with zooglass." + setting);
        }
    }
}
