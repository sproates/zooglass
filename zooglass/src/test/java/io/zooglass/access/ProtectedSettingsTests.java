package io.zooglass.access;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import static org.assertj.core.api.Assertions.*;

class ProtectedSettingsTests {
    static MockEnvironment valid() {
        return new MockEnvironment().withProperty("zooglass.access.mode", "applicationPolicy")
                .withProperty("server.ssl.enabled", "true")
                .withProperty("zooglass.access.tenant", "tenant-a")
                .withProperty("zooglass.access.policy-url", "https://policy.example/decision")
                .withProperty("zooglass.access.service-token", "service-secret")
                .withProperty("zooglass.access.origin", "https://viewer.example")
                .withProperty("zooglass.access.operator-port", "9091")
                .withProperty("zooglass.access.operator-token", "synthetic-operator-token-0123456789");
    }

    @Test
    void validatesCompleteDeploymentAndRedactsSecrets() {
        var settings = ProtectedSettings.read(valid());
        assertThat(settings.policy().tenant()).isEqualTo("tenant-a");
        assertThat(settings.operatorPort()).isEqualTo(9091);
        assertThat(settings.cookie()).isEqualTo("session");
        assertThat(settings.toString()).doesNotContain(settings.operatorToken(), settings.policy().serviceToken());
    }

    @Test
    void refusesUnverifiedTransportAndManagementConfigurations() {
        for (var entry : java.util.Map.of("server.ssl.enabled", "false", "server.http2.enabled", "true",
                "server.forward-headers-strategy", "framework", "management.server.port", "9092",
                "zooglass.access.operator-port", "65536", "zooglass.access.operator-token", "short").entrySet()) {
            assertThatThrownBy(() -> ProtectedSettings.read(valid().withProperty(entry.getKey(), entry.getValue())))
                    .as(entry.getKey()).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void missingOperatorCredentialCannotEnableServing() {
        var missing = valid();
        var properties = (org.springframework.core.env.MapPropertySource) missing.getPropertySources().get("mockProperties");
        properties.getSource().remove("zooglass.access.operator-token");
        assertThatThrownBy(() -> new AdmissionAccess(missing)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("zooglass.access.operator-token");
    }
}
