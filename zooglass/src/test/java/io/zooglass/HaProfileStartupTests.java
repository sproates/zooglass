package io.zooglass;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HaProfileStartupTests {
    @Test
    void unknownOrMissingDeploymentProfileCannotSilentlySelectStandaloneWithHaSettings() {
        var service = new ZooGlassApplication();
        assertThatThrownBy(() -> service.checkDeployment(new MockEnvironment()
                .withProperty("zooglass.deployment.profile", "ha-static-v2")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("Unknown ZooGlass deployment");
        assertThatThrownBy(() -> service.checkDeployment(new MockEnvironment()
                .withProperty("zooglass.ha.runtime-id", "configured-for-ha")))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("explicit HA deployment profile");
    }
}
