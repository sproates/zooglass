package io.zooglass;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import static org.assertj.core.api.Assertions.assertThat;

class ViewSnapshotOwnershipTests {
    @TestFactory
    Stream<DynamicTest> sourceAndReturnedSnapshotsCannotMutateStoredFields() {
        return Stream.of("arrival", "latestBySequence", "historyBySequence")
                .map(mode -> DynamicTest.dynamicTest(mode, () -> {
                    var mapper = JsonMapper.builder().build();
                    var ordering = mode.equals("arrival") ? null
                            : Map.of("position", new ViewConfiguration.Ordering(mode, "sequence"));
                    var definition = new ViewConfiguration.ViewDefinition("positions",
                            Map.of("position", List.of(new ViewConfiguration.EventMatcher("feed", "position"))),
                            ordering);
                    var store = new ViewStore(new ViewConfiguration(List.of(definition)));
                    ObjectNode input = (ObjectNode) mapper.readTree("{\"sequence\":1,\"nested\":{\"value\":7}}");
                    JsonNode expected = mode.equals("historyBySequence")
                            ? mapper.readTree("[{\"sequence\":1,\"nested\":{\"value\":7}}]")
                            : mapper.readTree("{\"sequence\":1,\"nested\":{\"value\":7}}");

                    var changes = store.apply("feed", "position", "entity", input);
                    ((ObjectNode) input.get("nested")).put("value", 99);
                    corruptNestedValue(changes.getFirst().data().get("position"));
                    var snapshot = store.get("positions", "entity").orElseThrow();
                    assertThat(snapshot.data().get("position")).isEqualTo(expected);
                    corruptNestedValue(snapshot.data().get("position"));
                    assertThat(store.get("positions", "entity").orElseThrow().data().get("position"))
                            .isEqualTo(expected);
                }));
    }

    private static void corruptNestedValue(JsonNode field) {
        JsonNode position = field.isArray() ? field.get(0) : field;
        ((ObjectNode) position.get("nested")).put("value", -1);
    }
}
