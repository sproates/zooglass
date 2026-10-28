package io.zooglass;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.stream.LongStream;
import java.util.stream.Stream;

import static io.zooglass.OrderingReference.event;
import static org.assertj.core.api.Assertions.assertThat;

class ViewStoreOrderingTests {
    private static final List<String> ENTITIES = List.of("car-17", "car-18", "never-seen");

    @TestFactory
    Stream<DynamicTest> generatedDeliveryOrdersMatchTheReferenceAfterEveryEvent() {
        String selectedSeed = System.getProperty("ordering.seed");
        LongStream seeds = selectedSeed == null ? LongStream.range(0, 64)
                : LongStream.of(Long.parseLong(selectedSeed));
        return seeds.mapToObj(seed -> DynamicTest.dynamicTest("delivery seed " + seed,
                () -> verifyPrefixes(deliveryOrder(seed), "seed=" + seed)));
    }

    @Test
    void everyPermutationOfThreePositionsAndADuplicateHasTheSameFinalViews() {
        var events = List.of(
                event("primary-feed", "position", "car-17", "40", "a"),
                event("primary-feed", "position", "car-17", "42", "c"),
                event("primary-feed", "position", "car-17", "41", "b"),
                event("primary-feed", "position", "car-17", "41", "b"));
        for (int a = 0; a < 4; a++) {
            for (int b = 0; b < 4; b++) {
                for (int c = 0; c < 4; c++) {
                    if (a == b || a == c || b == c) {
                        continue;
                    }
                    int d = 6 - a - b - c;
                    verifyPrefixes(List.of(events.get(a), events.get(b), events.get(c), events.get(d)),
                            "permutation=" + List.of(a, b, c, d));
                }
            }
        }
    }

    @Test
    void equalSequenceConflictsKeepTheFirstPayloadWithinEachFieldAndEntity() {
        var first = event("primary-feed", "position", "car-17", "1", "first");
        var conflict = event("backup-feed", "position", "car-17", "1.0", "conflict");
        ViewStore store = new ViewStore(OrderingReference.configuration());
        store.apply(first.source(), first.type(), first.entity(), first.payload());
        store.apply(conflict.source(), conflict.type(), conflict.entity(), conflict.payload());

        Map<String, JsonNode> latest = store.get("latest", "car-17").orElseThrow().data();
        assertThat(latest).containsEntry("primary", first.payload())
                .containsEntry("backup", conflict.payload()).containsEntry("shared", first.payload());
        assertThat(store.get("history", "car-17").orElseThrow().data().get("shared"))
                .containsExactly(first.payload());
        verifyPrefixes(List.of(conflict, first), "reversed conflicting arrival order");
    }

    private static List<OrderingReference.Event> deliveryOrder(long seed) {
        List<OrderingReference.Event> events = new ArrayList<>();
        // Include fractional, negative and beyond-double-precision integers in every run.
        List<String> sequences = List.of("-2", "0", "1", "1.0", "1.25", "42",
                "9007199254740992", "9007199254740993");
        for (String entity : ENTITIES.subList(0, 2)) {
            for (String source : List.of("primary-feed", "backup-feed")) {
                for (String sequence : sequences) {
                    var reading = event(source, "position", entity, sequence,
                            source + ":" + entity + ":" + sequence);
                    events.add(reading);
                    events.add(reading); // Exact duplicate; different sources also conflict at equal sequences.
                }
                events.add(event(source, "position", entity, null, "missing"));
                events.add(event(source, "position", entity, "\"999\"", "text"));
                events.add(event(source, "position", entity, "null", "null"));
                events.add(event(source, "unmatched-type", entity, "999", "wrong-type"));
            }
            events.add(event("unmatched-source", "position", entity, "999", "wrong-source"));
        }
        Collections.shuffle(events, new Random(seed));
        return events;
    }

    private static void verifyPrefixes(List<OrderingReference.Event> events, String caseName) {
        ViewStore store = new ViewStore(OrderingReference.configuration());
        List<OrderingReference.Event> received = new ArrayList<>();
        for (var event : events) {
            var beforeLatest = OrderingReference.expected(received, event.entity(), false);
            var beforeHistory = OrderingReference.expected(received, event.entity(), true);
            received.add(event);
            String context = caseName + ", prefix length=" + received.size() + ", received=" + received;
            var changes = store.apply(event.source(), event.type(), event.entity(), event.payload());
            List<ViewSnapshot> expectedChanges = new ArrayList<>();
            var latest = OrderingReference.expected(received, event.entity(), false);
            var history = OrderingReference.expected(received, event.entity(), true);
            if (!latest.equals(beforeLatest)) {
                expectedChanges.add(new ViewSnapshot("latest", event.entity(), latest));
            }
            if (!history.equals(beforeHistory)) {
                expectedChanges.add(new ViewSnapshot("history", event.entity(), history));
            }
            assertThat(changes).as(context).containsExactlyInAnyOrderElementsOf(expectedChanges);
            for (String entity : ENTITIES) {
                assertView(store, received, entity, "latest", false, context);
                assertView(store, received, entity, "history", true, context);
            }
        }
    }

    private static void assertView(ViewStore store, List<OrderingReference.Event> received,
            String entity, String view, boolean history, String context) {
        var expected = OrderingReference.expected(received, entity, history);
        var actual = store.get(view, entity);
        if (expected.isEmpty()) {
            assertThat(actual).as(context + ", " + view + "/" + entity).isEmpty();
        } else {
            assertThat(actual).as(context + ", " + view + "/" + entity)
                    .contains(new ViewSnapshot(view, entity, expected));
        }
    }
}
