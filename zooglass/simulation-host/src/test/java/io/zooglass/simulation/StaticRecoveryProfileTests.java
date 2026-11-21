package io.zooglass.simulation;

import static io.zooglass.simulation.StaticViewsTestSupport.configuration;
import static io.zooglass.simulation.StaticViewsTestSupport.field;
import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.runtime.StaticRecoveryTimelineProfile;
import io.zooglass.runtime.StaticViewsTimelineProfile;
import io.zooglass.runtime.TimelineRuntime;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class StaticRecoveryProfileTests {
    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void admitsMixedStrategiesWithoutWeakeningPolicyOrResourceBounds(String storage) {
        var config = configuration().put("storage", storage);
        assertThat(StaticRecoveryTimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString()))).isEmpty();
        assertThat(StaticViewsTimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString())).isEmpty())
                .isEqualTo(storage.equals("memory"));
        config.put("maxStreams", 21);
        assertThat(StaticRecoveryTimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString())))
                .extracting(StaticViewsTimelineProfile.Issue::path).contains("$.maxStreams");
        config.put("maxStreams", 20);
        field(config, "arrival").set("freshness", HostProtocol.JSON.readTree("{\"mode\":\"receiptAge\",\"staleAfterMillis\":5}"));
        assertThat(StaticRecoveryTimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString())))
                .extracting(StaticViewsTimelineProfile.Issue::path).contains("$.views[0].fields[\"arrival\"].freshness.mode");
    }
}
