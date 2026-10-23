package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ViewStoreTests {

    private final JsonMapper objectMapper = JsonMapper.builder().build();

    @Test
    void matchingEventsReplaceTheirFieldAndRemainScopedToTheirEntity() throws Exception {
        ViewStore store = new ViewStore(configuration());

        assertThat(store.get("match", "match-42")).isEmpty();

        store.apply("unmatched-feed", "score.updated", "match-42", payload("{\"home\":9}"));
        store.apply("match-feed", "score.updated", "match-42", payload("{\"home\":0,\"away\":0}"));
        store.apply("bookmaker", "odds.updated", "match-42", payload("{\"homeWin\":2.1}"));
        store.apply("match-feed", "score.corrected", "match-42", payload("{\"home\":1,\"away\":0}"));
        store.apply("match-feed", "score.updated", "match-99", payload("{\"home\":2,\"away\":1}"));

        ViewSnapshot match42 = store.get("match", "match-42").orElseThrow();
        assertThat(match42.data().get("score")).isEqualTo(payload("{\"home\":1,\"away\":0}"));
        assertThat(match42.data().get("odds")).isEqualTo(payload("{\"homeWin\":2.1}"));

        ViewSnapshot match99 = store.get("match", "match-99").orElseThrow();
        assertThat(match99.data()).containsOnlyKeys("score");
        assertThat(match99.data().get("score")).isEqualTo(payload("{\"home\":2,\"away\":1}"));
    }

    @Test
    void vehicleViewsCanKeepTheLatestPositionOrAnOrderedHistory() throws Exception {
        ViewConfiguration configuration = new ViewConfiguration(List.of(
                new ViewConfiguration.ViewDefinition("live-map", Map.of(
                        "position", List.of(new ViewConfiguration.EventMatcher(
                                "vehicle-feed", "vehicle.location.updated"))),
                        Map.of("position", new ViewConfiguration.Ordering("latestBySequence", "sequence"))),
                new ViewConfiguration.ViewDefinition("trip-history", Map.of(
                        "positions", List.of(new ViewConfiguration.EventMatcher(
                                "vehicle-feed", "vehicle.location.updated"))),
                        Map.of("positions", new ViewConfiguration.Ordering("historyBySequence", "sequence")))));
        ViewStore store = new ViewStore(configuration);

        store.apply("vehicle-feed", "vehicle.location.updated", "car-17",
                payload("{\"sequence\":42,\"latitude\":51.2}"));
        store.apply("vehicle-feed", "vehicle.location.updated", "car-17",
                payload("{\"sequence\":40,\"latitude\":51.0}"));
        store.apply("vehicle-feed", "vehicle.location.updated", "car-17",
                payload("{\"sequence\":41,\"latitude\":51.1}"));
        store.apply("vehicle-feed", "vehicle.location.updated", "car-17",
                payload("{\"sequence\":41,\"latitude\":51.1}"));

        assertThat(store.get("live-map", "car-17").orElseThrow().data().get("position"))
                .isEqualTo(payload("{\"sequence\":42,\"latitude\":51.2}"));
        assertThat(store.get("trip-history", "car-17").orElseThrow().data().get("positions"))
                .isEqualTo(payload("[{\"sequence\":40,\"latitude\":51.0},"
                        + "{\"sequence\":41,\"latitude\":51.1},"
                        + "{\"sequence\":42,\"latitude\":51.2}]"));
    }

    @Test
    void rejectsAViewWithoutFields() {
        ViewConfiguration invalidConfiguration = new ViewConfiguration(List.of(
                new ViewConfiguration.ViewDefinition("empty", Map.of())));

        assertThatThrownBy(() -> new ViewStore(invalidConfiguration))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("must define at least one field");
    }

    private JsonNode payload(String json) throws Exception {
        return objectMapper.readTree(json);
    }

    private static ViewConfiguration configuration() {
        return new ViewConfiguration(List.of(
                new ViewConfiguration.ViewDefinition("match", Map.of(
                        "score", List.of(
                                new ViewConfiguration.EventMatcher("match-feed", "score.updated"),
                                new ViewConfiguration.EventMatcher("match-feed", "score.corrected")),
                        "odds", List.of(new ViewConfiguration.EventMatcher("bookmaker", "odds.updated"))))));
    }
}
