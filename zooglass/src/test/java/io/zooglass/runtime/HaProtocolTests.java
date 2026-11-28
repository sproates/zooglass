package io.zooglass.runtime;

import io.zooglass.access.AdmissionAccess;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.DefaultResourceLoader;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.*;

class HaProtocolTests {
    @Test
    void unsafeListenerSettingsFailBeforeOpeningAResourceOrDatabase() {
        var environment = new MockEnvironment().withProperty("zooglass.access.mode", "openDemo")
                .withProperty("server.ssl.enabled", "true").withProperty("server.forward-headers-strategy", "none")
                .withProperty("server.http2.enabled", "true");
        assertThatThrownBy(() -> new HaSettings(environment, new DefaultResourceLoader(), new AdmissionAccess()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("direct viewer TLS");
        environment.withProperty("server.http2.enabled", "false").withProperty("server.tomcat.remoteip.protocol-header", "X-Test");
        assertThatThrownBy(() -> new HaSettings(environment, new DefaultResourceLoader(), new AdmissionAccess()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("direct viewer TLS");
    }

    @Test
    void requiresAnExplicitPositiveQualityMediaRange() {
        assertThat(HaEndpoints.negotiated("application/json, APPLICATION/VND.ZOOGLASS.HA-V1+JSON;q=.5")).isTrue();
        for (String rejected : new String[]{null, "", "*/*", "application/*", HaEndpoints.MEDIA + ";q=0", "invalid"}) {
            assertThat(HaEndpoints.negotiated(rejected)).isFalse();
        }
    }

    @Test
    void commandsRejectUnknownFieldsDuplicateKeysAndInexactCounters() {
        String command = """
                {"action":"subscribe","subscription":"%s","viewId":"v","entityId":"e"%s}
                """;
        assertThat(HaCommand.parse(command.formatted("9223372036854775807", "")).id()).isEqualTo(Long.MAX_VALUE);
        for (var invalid : new String[]{"0","01","+1","1e2","9223372036854775808"}) {
            assertThatThrownBy(() -> HaCommand.parse(command.formatted(invalid, ""))).isInstanceOf(RuntimeException.class);
        }
        for (var extra : new String[]{",\"cursor\":0", ",\"subscription\":\"2\"", ",\"recovery\":\"resume\""}) {
            assertThatThrownBy(() -> HaCommand.parse(command.formatted("1", extra))).isInstanceOf(RuntimeException.class);
        }
    }
}
