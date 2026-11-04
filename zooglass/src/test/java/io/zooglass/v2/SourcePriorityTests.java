package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;
import java.util.Map;

import static io.zooglass.v2.IdentityFixtures.parse;
import static org.assertj.core.api.Assertions.*;

class SourcePriorityTests {
    @TempDir Path directory;

    static V2Configuration configuration(String storage) {
        var inputs = List.of(new V2Configuration.Input("primary", "updated"),
                new V2Configuration.Input("backup", "updated"));
        var mappings = Map.of("primary", new V2Configuration.Entity("lookupEntity", Map.of("shipment", "order")),
                "backup", new V2Configuration.Entity("lookupEntity", Map.of("tracking", "order")));
        var views = List.of(
                new V2Configuration.View("primary-first", Map.of("status", new V2Configuration.Field(null, null,
                        "latestBySequence", inputs, new V2Configuration.Conflict("sourcePriority", List.of("primary", "backup")))), mappings),
                new V2Configuration.View("backup-first", Map.of("status", new V2Configuration.Field(null, null,
                        "latestBySequence", inputs, new V2Configuration.Conflict("sourcePriority", List.of("backup", "primary")))), mappings));
        return new V2Configuration(2, storage, 10, 1000, 10,
                List.of(new V2Configuration.Source("primary", "v1"), new V2Configuration.Source("backup", "v1")), views);
    }

    static Publication event(String source, long sequence) {
        return parse(source, "v1", source.equals("primary") ? "shipment" : "tracking", sequence, "updated", "{\"status\":\"ready\"}");
    }

    @ParameterizedTest
    @ValueSource(strings = {"memory", "sqlite"})
    void sourcesKeepIndependentSequenceDomainsAndViewLocalPriorities(String storage) {
        try (var runtime = new ViewCoordinator(configuration(storage), directory.resolve("state.db").toString())) {
            runtime.apply(event("backup", 900));
            assertWinner(runtime, "primary-first", "backup", 900, 1);
            var primary = runtime.apply(event("primary", 2));
            assertThat(primary.changedViews()).containsExactly("primary-first");
            assertThat(primary.targets().get(1).changedFields()).isEmpty();
            assertWinner(runtime, "primary-first", "primary", 2, 2);
            assertWinner(runtime, "backup-first", "backup", 900, 1);
            runtime.apply(event("backup", 901));
            assertWinner(runtime, "primary-first", "primary", 2, 2);
            assertWinner(runtime, "backup-first", "backup", 901, 3);
            assertThat(runtime.apply(event("primary", 1)).changedViews()).isEmpty();
            assertThat(runtime.apply(event("backup", 899)).changedViews()).isEmpty();
            assertWinner(runtime, "primary-first", "primary", 2, 2);
            assertThat(runtime.apply(event("primary", 2)).targets()).isEqualTo(primary.targets());
            assertThat(runtime.apply(parse("primary", "v1", "missing", 1, "updated", "{}")).targets())
                    .allSatisfy(target -> assertThat(target.reason()).isEqualTo("unknownEntityMapping"));
            assertThat(runtime.snapshot("primary-first", "missing").orElseThrow().data()).isEmpty();
        }
    }

    @Test
    void candidatesAreIsolatedByFieldTypeAndEntityAndSnapshotsOwnTheirValues() {
        var initial = configuration("memory");
        var status = initial.views().getFirst().fields().get("status");
        var location = new V2Configuration.Field(null, null, "latestBySequence",
                List.of(new V2Configuration.Input("primary", "location"), new V2Configuration.Input("backup", "location")),
                new V2Configuration.Conflict("sourcePriority", List.of("backup", "primary")));
        var view = new V2Configuration.View("combined", Map.of("status", status, "location", location));
        var config = new V2Configuration(2, "memory", 10, 1000, 10, initial.sources(), List.of(view));
        try (var runtime = new ViewCoordinator(config)) {
            runtime.apply(parse("primary", "v1", "one", 2, "updated", "{}"));
            runtime.apply(parse("backup", "v1", "one", 900, "updated", "{}"));
            runtime.apply(parse("backup", "v1", "one", 901, "location", "{}"));
            runtime.apply(parse("backup", "v1", "two", 1, "updated", "{}"));
            var one = runtime.snapshot("combined", "one").orElseThrow();
            assertThat(one.provenance().get("status").sourceId()).isEqualTo("primary");
            assertThat(one.provenance().get("location").sourceId()).isEqualTo("backup");
            assertThat(one.data().get("status").path("publicationSequence").longValue()).isEqualTo(2);
            assertThat(one.data().get("location").path("publicationSequence").longValue()).isEqualTo(901);
            var two = runtime.snapshot("combined", "two").orElseThrow();
            assertThat(two.data()).containsOnlyKeys("status");
            assertThat(two.provenance().get("status").sourceId()).isEqualTo("backup");
            ((tools.jackson.databind.node.ObjectNode) one.data().get("status")).put("publicationSequence", 999);
            assertThat(runtime.snapshot("combined", "one").orElseThrow().data().get("status")
                    .path("publicationSequence").longValue()).isEqualTo(2);
        }
    }

    @Test
    void equalValueAndSequenceStillChangesWinnerAndVersion() {
        try (var runtime = new ViewCoordinator(configuration("memory"))) {
            runtime.apply(event("backup", 2));
            var before = runtime.snapshot("primary-first", "order").orElseThrow();
            var result = runtime.apply(event("primary", 2));
            assertThat(result.changedViews()).containsExactly("primary-first");
            var after = runtime.snapshot("primary-first", "order").orElseThrow();
            assertThat(after.data()).isEqualTo(before.data());
            assertThat(after.provenance()).isNotEqualTo(before.provenance());
            assertThat(after.version()).isEqualTo(2);
        }
    }

    @Test
    void hiddenCandidatesAreDurableWithoutAdvancingVisibleVersion() throws Exception {
        Path database = directory.resolve("state.db");
        var full = configuration("sqlite");
        var config = new V2Configuration(2, "sqlite", 10, 1000, 10, full.sources(), List.of(full.views().getFirst()));
        PublicationOutcome hidden;
        try (var runtime = new ViewCoordinator(config, database.toString())) {
            runtime.apply(event("primary", 2));
            hidden = runtime.apply(event("backup", 900));
            assertThat(hidden.version()).isEqualTo(2);
            assertThat(hidden.changedViews()).isEmpty();
            assertThat(hidden.targets().getFirst().changedFields()).isEmpty();
        }
        try (var runtime = new ViewCoordinator(config, database.toString())) {
            assertWinner(runtime, "primary-first", "primary", 2, 1);
            assertThat(runtime.apply(event("backup", 900)).targets()).isEqualTo(hidden.targets());
            assertThat(runtime.apply(event("backup", 899)).changedViews()).isEmpty();
        }
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + database);
                var statement = connection.createStatement();
                var rows = statement.executeQuery("SELECT json_extract(state,'$.candidates.status.backup.value.publicationSequence') FROM views")) {
            assertThat(rows.next()).isTrue();
            assertThat(rows.getLong(1)).isEqualTo(900);
        }
    }

    private static void assertWinner(ViewCoordinator runtime, String view, String source, long sequence, long version) {
        var snapshot = runtime.snapshot(view, "order").orElseThrow();
        assertThat(snapshot.version()).isEqualTo(version);
        assertThat(snapshot.data().get("status").path("publicationSequence").longValue()).isEqualTo(sequence);
        assertThat(snapshot.provenance().get("status").sourceId()).isEqualTo(source);
    }
}
