package io.zooglass;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.spy;

class ViewStoreAtomicityTests {
    private final JsonMapper json = new JsonMapper();
    private final JsonNode original = json.readTree("{\"value\":1}");
    private final JsonNode replacement = json.readTree("{\"value\":2}");

    @ParameterizedTest(name = "evaluation rollback, existing entity: {0}")
    @ValueSource(booleans = {false, true})
    void laterFieldFailureLeavesEveryViewUnchanged(boolean existing) {
        ViewStore store = store();
        if (existing) store.apply("feed", "reading", "entity", original);

        RuntimeException failure = new IllegalStateException("later field evaluation failed");
        JsonNode incoming = spy(replacement.deepCopy());
        AtomicInteger copies = new AtomicInteger();
        doAnswer(invocation -> {
            if (copies.incrementAndGet() == 3) throw failure;
            return replacement.deepCopy();
        }).when(incoming).deepCopy();

        assertThatThrownBy(() -> store.apply("feed", "reading", "entity", incoming)).isSameAs(failure);
        assertUnchanged(store, existing);
        assertRetrySucceeds(store);
    }

    @ParameterizedTest(name = "snapshot rollback, existing entity: {0}")
    @ValueSource(booleans = {false, true})
    void snapshotCopyFailureDoesNotInstallCandidateState(boolean existing) {
        ViewStore store = store();
        if (existing) store.apply("feed", "reading", "entity", original);

        RuntimeException failure = new IllegalStateException("snapshot copy failed");
        JsonNode candidate = spy(replacement.deepCopy());
        AtomicInteger snapshotCopies = new AtomicInteger();
        doAnswer(invocation -> {
            if (snapshotCopies.incrementAndGet() == 1) throw failure;
            return replacement.deepCopy();
        }).when(candidate).deepCopy();
        JsonNode incoming = spy(replacement.deepCopy());
        doAnswer(invocation -> candidate).when(incoming).deepCopy();

        assertThatThrownBy(() -> store.apply("feed", "reading", "entity", incoming)).isSameAs(failure);
        assertUnchanged(store, existing);
        assertRetrySucceeds(store);
    }

    private ViewStore store() {
        var matcher = List.of(new ViewConfiguration.EventMatcher("feed", "reading"));
        Map<String, List<ViewConfiguration.EventMatcher>> fields = new LinkedHashMap<>();
        fields.put("first", matcher);
        fields.put("second", matcher);
        return new ViewStore(new ViewConfiguration(List.of(
                new ViewConfiguration.ViewDefinition("single", Map.of("reading", matcher)),
                new ViewConfiguration.ViewDefinition("multiple", fields))));
    }

    private void assertUnchanged(ViewStore store, boolean existing) {
        if (existing) {
            assertThat(store.get("single", "entity").orElseThrow().data())
                    .isEqualTo(Map.of("reading", original));
            assertThat(store.get("multiple", "entity").orElseThrow().data())
                    .isEqualTo(Map.of("first", original, "second", original));
        } else {
            assertThat(store.get("single", "entity")).isEmpty();
            assertThat(store.get("multiple", "entity")).isEmpty();
        }
    }

    private void assertRetrySucceeds(ViewStore store) {
        var snapshots = store.apply("feed", "reading", "entity", replacement);
        assertThat(snapshots).extracting(ViewSnapshot::viewId).containsExactly("single", "multiple");
        assertThat(snapshots.get(0).data()).isEqualTo(Map.of("reading", replacement));
        assertThat(snapshots.get(1).data()).isEqualTo(Map.of("first", replacement, "second", replacement));
        assertThat(store.get("single", "entity").orElseThrow()).isEqualTo(snapshots.get(0));
        assertThat(store.get("multiple", "entity").orElseThrow()).isEqualTo(snapshots.get(1));
    }
}
