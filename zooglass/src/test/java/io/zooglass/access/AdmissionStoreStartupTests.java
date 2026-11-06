package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.runtime.Publication;
import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.StoreAdoption;
import io.zooglass.runtime.ViewCoordinator;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.io.DefaultResourceLoader;
import org.springframework.mock.env.MockEnvironment;

import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

class AdmissionStoreStartupTests {

    @TempDir Path directory;

    @Test
    void applicationStartupBindsTheRuntimeToTheAdmissionTenant() throws Exception {
        var configuration = new RuntimeConfiguration(2, "sqlite", 10, 10, 10,
                List.of(new RuntimeConfiguration.Source("feed", "run")),
                List.of(new RuntimeConfiguration.View("orders", Map.of("value",
                        new RuntimeConfiguration.Field("feed", "value", "arrival")))));
        var json = new JsonMapper();
        Path config = directory.resolve("views.json");
        Path database = directory.resolve("state.sqlite");
        Files.writeString(config, json.writeValueAsString(configuration));
        var environment = new MockEnvironment().withProperty("zooglass.config", config.toUri().toString())
                .withProperty("zooglass.database", database.toString());
        try (var runtime = new ViewCoordinator(new DefaultResourceLoader(), environment, new AdmissionAccess())) {
            runtime.apply(new Publication("feed", "run", "42", 1, "value", json.readTree("{\"private\":true}")));
        }
        StoreAdoption.adopt(database, "tenant-a");
        for (String tenant : List.of("tenant-b", "tenant-a", "open")) {
            new ApplicationContextRunner()
                    .withBean(AdmissionAccess.class, () -> "open".equals(tenant) ? new AdmissionAccess()
                            : new AdmissionAccess(new ApplicationPolicyAccess(tenant,
                                    (credential, resource) -> AdmissionBoundaryTests.allow(), System::nanoTime),
                                    tenant, AdmissionBoundaryTests.ORIGIN, "session"))
                    .withBean(ViewCoordinator.class)
                    .withPropertyValues("zooglass.config=" + config.toUri(), "zooglass.database=" + database)
                    .run(context -> {
                        if ("tenant-a".equals(tenant)) {
                            assertThat(context.getStartupFailure()).isNull();
                            assertThat(context.getBean(ViewCoordinator.class).snapshot("orders", "42")
                                    .orElseThrow().data()).containsKey("value");
                        } else {
                            assertThat(context.getStartupFailure()).hasRootCauseMessage("open".equals(tenant)
                                    ? "Open demo mode cannot open a tenant-bound store"
                                    : "Database tenant does not match the configured tenant");
                        }
                    });
        }
    }
}
