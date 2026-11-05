package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.api.ViewSnapshot;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.json.JsonMapper;

import java.util.List;

class PublicSnapshotTests {
    private static final JsonMapper JSON = new JsonMapper();

    @Test
    void ordinaryPayloadKeysCannotBeMistakenForTransportMetadata() {
        var payload = "{\"publicationSequence\":999,\"payload\":{\"value\":7}}";
        try (var runtime = new ViewCoordinator(IdentityFixtures.configuration(10, 100, 100))) {
            runtime.apply(IdentityFixtures.parse("fleet", "trip-1", "car", 1, "position", payload));
            var latest = ViewSnapshot.from(runtime.snapshot("latest", "car").orElseThrow());
            assertThat(latest.data().get("position")).isEqualTo(JSON.readTree(payload));
            assertThat(latest.publicationSequences()).containsEntry("position", List.of(1L));
            var history = ViewSnapshot.from(runtime.snapshot("history", "car").orElseThrow());
            assertThat(history.data().get("position")).containsExactly(JSON.readTree(payload));
            assertThat(history.publicationSequences()).containsEntry("position", List.of(1L));
        }
    }

    @Test
    void factRecordsAndAggregateValuesRemainTheirConfiguredProjections() {
        try (var runtime = new ViewCoordinator(FactFixtures.scores("memory"))) {
            runtime.apply(
                    FactFixtures.event(
                            1, 1, 1, "create", "{\"points\":3,\"publicationSequence\":999}"));
            var internal = FactFixtures.snapshot(runtime, "corrected");
            var response = ViewSnapshot.from(internal);
            assertThat(response.data()).isEqualTo(internal.data());
            assertThat(response.data().get("score").intValue()).isEqualTo(3);
            assertThat(
                            response.data()
                                    .get("goals")
                                    .get(0)
                                    .at("/payload/publicationSequence")
                                    .intValue())
                    .isEqualTo(999);
            assertThat(response.publicationSequences()).isEmpty();
        }
    }
}
