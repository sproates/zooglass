package io.zooglass.strategy.update;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.ViewConfiguration;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

class FieldStrategyTests {

    private final JsonMapper mapper = new JsonMapper();

    @Test
    void configurationSelectsConcreteModulesAndRejectsUnknownModes() {
        assertThat(FieldStrategySelection.select(null)).isInstanceOf(ArrivalReplacement.class);
        assertThat(selected("latestBySequence")).isInstanceOf(LatestBySequence.class);
        assertThat(selected("historyBySequence")).isInstanceOf(HistoryBySequence.class);
        assertThatThrownBy(() -> selected("unknown")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void arrivalReplacesEvenEqualContentAndOwnsNestedData() {
        JsonNode incoming = event("42", "first");
        FieldUpdate result = new ArrivalReplacement().evaluate(incoming, incoming);
        assertThat(result.changed()).isTrue();
        assertThat(result.replacement()).isEqualTo(incoming).isNotSameAs(incoming);
        mutate(result.replacement(), "changed");
        assertThat(incoming.path("data").path("label").asText()).isEqualTo("first");
    }

    @Test
    void sequenceStrategiesIgnoreInvalidInputWithoutChangingExistingState() {
        for (String mode : new String[] {"latestBySequence", "historyBySequence"}) {
            FieldUpdateStrategy strategy = selected(mode);
            JsonNode current = strategy.evaluate(null, event("40", "first")).replacement();
            JsonNode original = current.deepCopy();
            for (String invalid :
                    new String[] {
                        "{}", "{\"ordinal\":null}", "{\"ordinal\":\"42\"}",
                    }) {
                for (JsonNode previous : new JsonNode[] {null, current}) {
                    FieldUpdate result = strategy.evaluate(previous, mapper.readTree(invalid));
                    assertThat(result.changed()).isFalse();
                    assertThat(result.replacement()).isNull();
                }
            }
            assertThat(current).isEqualTo(original);
        }
    }

    @Test
    void latestUsesConfiguredKeyAndExactNumbersWithoutRetainingEntityState() {
        FieldUpdateStrategy strategy = selected("latestBySequence");
        JsonNode first = event("9007199254740992", "first");
        JsonNode next = event("9007199254740993", "next");
        FieldUpdate update = strategy.evaluate(first, next);
        assertThat(update.changed()).isTrue();
        assertThat(update.replacement()).isEqualTo(next);
        assertThat(strategy.evaluate(next, first).changed()).isFalse();
        assertThat(strategy.evaluate(first, event("9007199254740992.0", "conflict")).changed())
                .isFalse();
        assertThat(strategy.evaluate(null, event("-1.25", "other entity")).changed()).isTrue();
        mutate(update.replacement(), "changed");
        assertThat(next.path("data").path("label").asText()).isEqualTo("next");
        assertThat(first.path("data").path("label").asText()).isEqualTo("first");
    }

    @Test
    void historyOrdersAndDeduplicatesWithoutMutatingOrSharingNestedValues() {
        FieldUpdateStrategy strategy = selected("historyBySequence");
        JsonNode forty = event("40", "a");
        JsonNode fortyTwo = event("42", "c");
        JsonNode fortyOne = event("41", "b");
        JsonNode current = strategy.evaluate(null, forty).replacement();
        current = strategy.evaluate(current, fortyTwo).replacement();
        JsonNode original = current.deepCopy();
        FieldUpdate update = strategy.evaluate(current, fortyOne);
        assertThat(update.replacement()).containsExactly(forty, fortyOne, fortyTwo);
        assertThat(current).isEqualTo(original);
        assertThat(strategy.evaluate(update.replacement(), event("41.0", "conflict")).changed())
                .isFalse();
        mutate(update.replacement().get(0), "changed old entry");
        mutate(update.replacement().get(1), "changed new entry");
        assertThat(current).isEqualTo(original);
        assertThat(fortyOne.path("data").path("label").asText()).isEqualTo("b");
        assertThat(strategy.evaluate(null, fortyOne).replacement()).containsExactly(fortyOne);
    }

    private FieldUpdateStrategy selected(String mode) {
        return FieldStrategySelection.select(new ViewConfiguration.Ordering(mode, "ordinal"));
    }

    private JsonNode event(String sequence, String label) {
        return mapper.readTree(
                "{\"ordinal\":" + sequence + ",\"data\":{\"label\":\"" + label + "\"}}");
    }

    private void mutate(JsonNode event, String label) {
        ((ObjectNode) event.get("data")).put("label", label);
    }
}
