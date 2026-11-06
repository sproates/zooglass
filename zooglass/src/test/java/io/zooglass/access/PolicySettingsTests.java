package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.net.URI;
import java.time.Duration;

class PolicySettingsTests {

    @ParameterizedTest
    @ValueSource(strings = {"http://example.com/policy", "/policy", "https://user:secret@example.com/",
            "https://example.com/?token=x", "https://example.com/#fragment", "https://example.com:0/",
            "https://example.com:65536/"})
    void rejectsUnsafeEndpoints(String endpoint) {
        assertThatThrownBy(() -> new PolicySettings("tenant", URI.create(endpoint),
                "service-secret", Duration.ofSeconds(1), 1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void validatesBoundsTenantAndTokenAndRedactsSecrets() {
        URI uri = URI.create("https://example.com/policy");
        for (Duration timeout : new Duration[] {Duration.ZERO, Duration.ofSeconds(6)}) {
            assertThatThrownBy(() -> new PolicySettings("tenant", uri, "secret", timeout, 1))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        for (int limit : new int[] {0, 257}) {
            assertThatThrownBy(() -> new PolicySettings("tenant", uri, "secret", Duration.ofSeconds(1), limit))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> new PolicySettings(" tenant", uri, "secret", Duration.ofSeconds(1), 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PolicySettings("tenant", uri, "secret\r\nheader", Duration.ofSeconds(1), 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(new PolicySettings("tenant", uri, "service-secret", Duration.ofSeconds(1), 1).toString())
                .doesNotContain("service-secret");
    }
}
