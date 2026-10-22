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
        store.apply("match-feed", "score.updated", "match-42", payload("{\"home\":1,\"away\":0}"));
        store.apply("match-feed", "score.updated", "match-99", payload("{\"home\":2,\"away\":1}"));

        ViewSnapshot match42 = store.get("match", "match-42").orElseThrow();
        assertThat(match42.data().get("score")).isEqualTo(payload("{\"home\":1,\"away\":0}"));
        assertThat(match42.data().get("odds")).isEqualTo(payload("{\"homeWin\":2.1}"));

        ViewSnapshot match99 = store.get("match", "match-99").orElseThrow();
        assertThat(match99.data()).containsOnlyKeys("score");
        assertThat(match99.data().get("score")).isEqualTo(payload("{\"home\":2,\"away\":1}"));
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
                        "score", new ViewConfiguration.EventMatcher("match-feed", "score.updated"),
                        "odds", new ViewConfiguration.EventMatcher("bookmaker", "odds.updated")))));
    }
}
