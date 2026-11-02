package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;

import static io.zooglass.v2.IdentityFixtures.event;
import static io.zooglass.v2.IdentityFixtures.parse;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SqliteRecoveryTests {
    @TempDir
    Path directory;

    static V2Configuration configuration() {
        var memory = IdentityFixtures.configuration(5, 3, 5);
        return new V2Configuration(2, "sqlite", 5, 3, 5, memory.sources(), memory.views());
    }

    @Test
    void restartRestoresViewsFloorsIdentitiesAndOriginalReceiptVersions() {
        String database = directory.resolve("state.sqlite").toString();
        var config = configuration();
        ViewCoordinator.Snapshot before;
        try (var first = new ViewCoordinator(config, database)) {
            assertThat(first.apply(event(40)).status()).isEqualTo("committed");
            first.apply(event(42));
            first.apply(event(41));
            first.apply(event(43)); // floor 41; identity 40 evicted, history retained
            before = first.snapshot("history", "car").orElseThrow();
        }

        try (var restored = new ViewCoordinator(config, database)) {
            var recovered = restored.snapshot("history", "car").orElseThrow();
            assertThat(recovered.version()).isEqualTo(before.version());
            assertThat(recovered.data().get("position").toString())
                    .isEqualTo(before.data().get("position").toString());
            assertThat(restored.apply(event(40)).reason()).isEqualTo("outsideRetention");
            var retry = restored.apply(parse("fleet", "trip-1", "car", 41, "position", "{\"value\":41.00}"));
            assertThat(retry.status()).isEqualTo("duplicate");
            assertThat(retry.reason()).isEqualTo("alreadyCommitted");
            assertThat(retry.version()).isEqualTo(3);
            assertThat(restored.apply(parse("fleet", "trip-1", "car", 41, "position", "{}")).reason())
                    .isEqualTo("identityConflict");
            assertThat(restored.apply(event(44)).version()).isEqualTo(5);
            assertThat(restored.snapshot("latest", "car").orElseThrow().data().get("position")
                    .path("publicationSequence").longValue()).isEqualTo(44);
        }
    }

    @Test
    void delayedPublicationAfterRestartUsesRestoredStrategyState() {
        String database = directory.resolve("state.sqlite").toString();
        var config = configuration();
        try (var first = new ViewCoordinator(config, database)) {
            first.apply(event(40));
            first.apply(event(42));
        }
        try (var restored = new ViewCoordinator(config, database)) {
            assertThat(restored.apply(event(41)).changedViews()).containsExactly("history", "arrival");
            assertThat(restored.snapshot("latest", "car").orElseThrow().data().get("position")
                    .path("publicationSequence").longValue()).isEqualTo(42);
            assertThat(restored.snapshot("history", "car").orElseThrow().data().get("position"))
                    .extracting(node -> node.path("publicationSequence").longValue())
                    .containsExactly(40L, 41L, 42L);
        }
    }

    @Test
    void configurationCanBeReorderedAndExtendedWithoutBackfillingNewViews() {
        String database = directory.resolve("state.sqlite").toString();
        var initial = configuration();
        try (var first = new ViewCoordinator(initial, database)) {
            first.apply(event(1));
        }
        var views = new ArrayList<>(initial.views());
        Collections.reverse(views);
        views.add(IdentityFixtures.view("new-latest", "latestBySequence"));
        var extended = new V2Configuration(2, "sqlite", 5, 3, 5, initial.sources(), views);

        try (var restored = new ViewCoordinator(extended, database)) {
            assertThat(restored.snapshot("new-latest", "car").orElseThrow().data()).isEmpty();
            assertThat(restored.apply(event(1)).status()).isEqualTo("duplicate");
            assertThat(restored.snapshot("new-latest", "car").orElseThrow().data()).isEmpty();
            restored.apply(event(2));
            assertThat(restored.snapshot("new-latest", "car").orElseThrow().version()).isEqualTo(2);
        }
        assertThatThrownBy(() -> new ViewCoordinator(initial, database))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void historyRejectionAndUnmatchedIdentitySurviveRestart() {
        String database = directory.resolve("state.sqlite").toString();
        var config = configuration();
        try (var first = new ViewCoordinator(config, database)) {
            for (int sequence = 1; sequence <= 5; sequence++) {
                first.apply(event(sequence));
            }
            assertThat(first.apply(event(100)).reason()).isEqualTo("historyLimit");
            first.apply(parse("backup", "trip-1", "unmatched", 1, "other", "{}"));
        }
        try (var restored = new ViewCoordinator(config, database)) {
            assertThat(restored.apply(event(3)).status()).isEqualTo("duplicate");
            assertThat(restored.apply(event(100)).reason()).isEqualTo("historyLimit");
            assertThat(restored.apply(parse("backup", "trip-1", "unmatched", 1, "other", "{}")).reason())
                    .isEqualTo("alreadyCommitted");
        }
    }

    @Test
    void secondOwnerFailsAndCloseReleasesTheDatabase() {
        String database = directory.resolve("state.sqlite").toString();
        try (var owner = new ViewCoordinator(configuration(), database)) {
            owner.apply(event(1));
            assertThatThrownBy(() -> new ViewCoordinator(configuration(), database))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(owner.apply(event(2)).status()).isEqualTo("committed");
        }
        try (var next = new ViewCoordinator(configuration(), database)) {
            assertThat(next.apply(event(2)).status()).isEqualTo("duplicate");
        }
    }
}
