package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.nio.file.Path;
import static io.zooglass.v2.FactFixtures.*;
import static org.assertj.core.api.Assertions.assertThat;

class FactCollectionTests {
    @TempDir Path directory;

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void policiesCorrectRetractAndRestoreOlderFactsIndependently(String storage) {
        try (var service = new ViewCoordinator(configuration(storage, 10, false), directory.resolve("state.db").toString())) {
            var first = event(1, 1, 1, "create", "{\"points\":1}");
            var receipt = service.apply(first);
            service.apply(event(2, 2, 1, "create", "{\"points\":1}"));
            var correction = service.apply(event(3, 1, 3, "revise", "{\"points\":2}"));
            assertThat(correction.targets().getFirst().fields().getFirst().reason()).isEqualTo("factImmutable");
            assertThat(snapshot(service, "original").data().get("goals").get(0).path("payload").path("points").intValue()).isEqualTo(1);
            assertThat(snapshot(service, "corrected").data().get("goals").get(0).path("payload").path("points").intValue()).isEqualTo(2);

            assertThat(service.apply(event(4, 1, 2, "revise", "{\"points\":9}")).targets().getLast().reason()).isEqualTo("obsoleteRevision");
            assertThat(service.apply(event(5, 1, 3, "revise", "{\"points\":9}")).targets().getLast().reason()).isEqualTo("revisionConflict");
            var equal = service.apply(event(6, 1, 3, "revise", "{\"points\":2.0}"));
            assertThat(equal.targets().getLast().changedFields()).isEmpty();
            service.apply(event(7, 1, 4, "retract", "{}"));
            var withdrawn = snapshot(service, "corrected");
            assertThat(withdrawn.data().get("goals")).extracting(n -> n.path("birthSequence").longValue()).containsExactly(2L);
            assertThat(withdrawn.status().fields().get("goals").facts().retainedCount()).isEqualTo(2);
            assertThat(withdrawn.status().fields().get("goals").facts().activeCount()).isEqualTo(1);
            assertThat(service.apply(first).version()).isEqualTo(receipt.version());
            assertThat(snapshot(service, "corrected")).isEqualTo(withdrawn);
            service.apply(event(8, 1, 5, "revise", "{\"points\":3}"));
            assertThat(snapshot(service, "corrected").data().get("goals"))
                    .extracting(n -> n.path("birthSequence").longValue()).containsExactly(1L, 2L);
        }
    }

    @Test
    void missingCreateAndCapacityRejectTheWholePublicationWithoutConsumingItsIdentity() {
        try (var service = new ViewCoordinator(configuration("memory", 1, false))) {
            var correction = event(2, 1, 2, "revise", "{}");
            assertThat(service.apply(correction).reason()).isEqualTo("unknownFact");
            assertThat(snapshot(service, "original").version()).isZero();
            assertThat(snapshot(service, "corrected").status().inputs().get("match").state()).isEqualTo("notObserved");
            service.apply(event(1, 1, 1, "create", "{}"));
            assertThat(service.apply(correction).status()).isEqualTo("applied");
            service.apply(event(3, 1, 3, "retract", "{}"));
            var before = snapshot(service, "corrected");
            var excess = event(4, 4, 1, "create", "{}");
            assertThat(service.apply(excess).reason()).isEqualTo("factLimit");
            assertThat(snapshot(service, "corrected")).isEqualTo(before);
            service.retire(retire("original", 4));
            service.retire(retire("corrected", 4));
            assertThat(service.apply(excess).status()).isEqualTo("applied");
        }
    }

    @Test
    void publicationMetadataIsPartOfRetryIdentityAndTheFactTypeCannotChange() {
        try (var service = new ViewCoordinator(configuration("memory", 10, false))) {
            service.apply(event(1, 1, 1, "create", "{}"));
            service.apply(event(2, 1, 2, "revise", "{}"));
            assertThat(service.apply(event(2, 1, 3, "revise", "{}")).reason()).isEqualTo("identityConflict");
            var wrongType = new Publication("match", "v1", "game", 3, "other", new tools.jackson.databind.json.JsonMapper().readTree("{}"),
                    new FactEnvelope(1, 3, "revise"));
            assertThat(service.apply(wrongType).reason()).isEqualTo("factTypeMismatch");
            assertThat(service.apply(event(3, 1, 3, "revise", "{}")).status()).isEqualTo("applied");
        }
    }

    @Test
    void oldBirthIsStillCorrectableAfterItsPublicationReceiptExpires() {
        try (var service = new ViewCoordinator(configuration("memory", 10, false))) {
            var first = event(1, 1, 1, "create", "{}");
            service.apply(first);
            service.apply(event(15, 1, 2, "revise", "{\"points\":2}"));
            assertThat(service.apply(first).reason()).isEqualTo("outsideRetention");
            assertThat(snapshot(service, "corrected").data().get("goals").get(0).path("revision").longValue()).isEqualTo(2);
            service.retire(retire("corrected", 2));
            assertThat(service.apply(event(16, 1, 3, "revise", "{}")).targets().getLast().reason()).isEqualTo("factOutsideRetention");
        }
    }
}
