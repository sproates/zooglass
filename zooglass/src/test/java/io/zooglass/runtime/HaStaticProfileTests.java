package io.zooglass.runtime;

import io.zooglass.delivery.SlowClientPolicy;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HaStaticProfileTests {
    static final RuntimeConfiguration.Source PRIMARY = new RuntimeConfiguration.Source("primary", "v1");
    static final RuntimeConfiguration.Source BACKUP = new RuntimeConfiguration.Source("backup", "v1");
    static final RuntimeConfiguration.Field ARRIVAL = new RuntimeConfiguration.Field("backup", "score", "arrival");
    static final RuntimeConfiguration.View TRAIL = new RuntimeConfiguration.View("trail", Map.of(
            "recent", ARRIVAL, "history", new RuntimeConfiguration.Field("backup", "score", "historyBySequence")));
    static final RuntimeConfiguration.Field CHOSEN = new RuntimeConfiguration.Field(null, null, "latestBySequence",
            List.of(new RuntimeConfiguration.Input("backup", "score"), new RuntimeConfiguration.Input("primary", "score")),
            new RuntimeConfiguration.Conflict("sourcePriority", List.of("primary", "backup")));
    static final RuntimeConfiguration.View POSITION = new RuntimeConfiguration.View("position", Map.of(
            "chosen", CHOSEN, "label", new RuntimeConfiguration.Field("primary", "label", "arrival")), null,
            new RuntimeConfiguration.Exposure("requireContributions", List.of("label", "chosen"), 3L));

    static RuntimeConfiguration config(List<RuntimeConfiguration.Source> sources, List<RuntimeConfiguration.View> views,
            RuntimeConfiguration.Delivery delivery) {
        return new RuntimeConfiguration(2, "postgresql", 6, 2, 2, sources, views, delivery);
    }

    static RuntimeConfiguration config() {
        return config(List.of(PRIMARY, BACKUP), List.of(TRAIL, POSITION), null);
    }

    static HaStaticProfile profile(RuntimeConfiguration config) {
        return new HaStaticProfile("static-runtime", "tenant-a", config);
    }

    @Test
    void publicStandaloneConstructionRemainsClosedAndIdentityIncludesLimitsDeliveryAndSourceRank() {
        assertThatThrownBy(() -> new ViewCoordinator(config())).isInstanceOf(IllegalArgumentException.class);
        var admitted = profile(config());
        assertThat(profile(config(List.of(BACKUP, PRIMARY), List.of(POSITION, TRAIL), null)).configurationIdentity())
                .isEqualTo(admitted.configurationIdentity());
        var delivery = new RuntimeConfiguration.Delivery(null, SlowClientPolicy.select("coalesceLatestState"), 8, 1024L);
        assertThat(profile(config(List.of(PRIMARY, BACKUP), List.of(TRAIL, POSITION), delivery)).configurationIdentity())
                .isNotEqualTo(admitted.configurationIdentity());
        var reversed = new RuntimeConfiguration.Field(null, null, "latestBySequence", CHOSEN.inputs(),
                new RuntimeConfiguration.Conflict("sourcePriority", List.of("backup", "primary")));
        var a = new RuntimeConfiguration.View("one", Map.of("field", CHOSEN));
        var b = new RuntimeConfiguration.View("one", Map.of("field", reversed));
        assertThat(profile(config(List.of(PRIMARY, BACKUP), List.of(a), null)).configurationIdentity())
                .isNotEqualTo(profile(config(List.of(PRIMARY, BACKUP), List.of(b), null)).configurationIdentity());
    }

    @Test
    void rejectsOutOfProfileCountsMappingsProgressFreshnessAndFacts() {
        var third = new RuntimeConfiguration.Source("third", "v1");
        var fourth = new RuntimeConfiguration.Source("fourth", "v1");
        reject(config(List.of(PRIMARY, BACKUP, third, fourth), List.of(), null));
        var one = new RuntimeConfiguration.View("one", Map.of("a", ARRIVAL));
        reject(config(List.of(PRIMARY, BACKUP), List.of(POSITION, TRAIL, one), null));
        var four = new RuntimeConfiguration.View("four", Map.of("a", ARRIVAL, "b", ARRIVAL, "c", ARRIVAL, "d", ARRIVAL));
        reject(config(List.of(BACKUP), List.of(four), null));
        var three = new RuntimeConfiguration.View("three", Map.of("a", ARRIVAL, "b", ARRIVAL, "c", ARRIVAL));
        reject(config(List.of(BACKUP), List.of(three, TRAIL), null));
        var lookup = new RuntimeConfiguration.View("lookup", Map.of("f", ARRIVAL),
                Map.of("backup", new RuntimeConfiguration.Entity("lookupEntity", Map.of("a", "b"))));
        reject(config(List.of(BACKUP), List.of(lookup), null));
        var tracked = new RuntimeConfiguration.Source("backup", "v1",
                new RuntimeConfiguration.Progress("contiguousSequence", 1L, 2L, 2L));
        reject(config(List.of(tracked), List.of(TRAIL), null));
        var timed = new RuntimeConfiguration.Field("backup", "score", "arrival", null, null, null,
                new RuntimeConfiguration.Freshness("receiptAge", 50L));
        var facts = new RuntimeConfiguration.Field("backup", "score", "activeFacts", null, null, null, null,
                new RuntimeConfiguration.Facts("firstFact", 2L, 1L), null);
        for (var field : List.of(timed, facts)) {
            reject(config(List.of(BACKUP), List.of(new RuntimeConfiguration.View("view", Map.of("f", field))), null));
        }
    }

    private static void reject(RuntimeConfiguration configuration) {
        assertThatThrownBy(() -> profile(configuration)).isInstanceOf(IllegalArgumentException.class);
    }
}
