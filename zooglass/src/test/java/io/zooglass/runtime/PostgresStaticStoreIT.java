package io.zooglass.runtime;

import io.zooglass.delivery.SlowClientPolicy;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.sql.SQLException;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static io.zooglass.runtime.HaStaticProfileTests.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Explicit real-backend gate. Missing fixture settings fail the test. */
class PostgresStaticStoreIT {
    private PostgresTestDatabase db;
    private final HaStaticProfile binding = profile(config());
    private static final String ENTITY = "car\0one";
    private static final String PRECISE = "19.000000000000000000000000001";

    @BeforeEach
    void createSchema() throws SQLException {
        db = new PostgresTestDatabase();
    }

    @AfterEach
    void dropSchema() throws SQLException {
        if (db != null) db.close();
    }

    private AdmittedPostgresRuntime open() {
        return new AdmittedPostgresRuntime(binding, db::open);
    }

    private static Publication event(String source, long sequence, String type, String number) {
        return new Publication(source, "v1", ENTITY, sequence, type, StateRowJson.JSON.readTree("{\"value\":" + number + "}"));
    }

    @Test
    void restartsPreserveHiddenCandidatesOriginalReceiptsFloorsAndRequiredRelease() throws SQLException {
        var low = event("backup", 2, "score", PRECISE);
        var high = event("primary", 1, "score", "7");
        PublicationOutcome original;
        try (var runtime = open()) {
            original = runtime.apply(low);
            assertThat(original.status()).isEqualTo("committed");
            assertThat(original.reason()).isEqualTo("postgresql");
            assertThat(original.version()).isEqualTo(1L);
            assertThat(original.targets()).extracting(TargetOutcome::viewId).containsExactly("position", "trail");
            assertThat(original.targets().getFirst().fields()).containsExactly(
                    new TargetOutcome.FieldOutcome("chosen", "accepted", null, false));
            assertThat(original.targets().getLast().changedFields()).containsExactly("history", "recent");
            assertThat(runtime.apply(high).version()).isEqualTo(2L);
            assertThat(runtime.snapshot("position", ENTITY).orElseThrow().data()).isEmpty();
        }
        try (var conn = db.open(); var sql = conn.createStatement();
                var row = sql.executeQuery("SELECT image, revision FROM zooglass_runtime")) {
            row.next();
            var restored = PostgresImage.restore(row.getString(1), row.getLong(2), binding.configuration());
            var hidden = restored.views().get(new StateImage.ViewEntity("position", ENTITY)).candidates().get("chosen");
            assertThat(hidden).containsOnlyKeys("primary", "backup");
            assertThat(hidden.get("backup").value().at("/payload/value").decimalValue()).isEqualByComparingTo(PRECISE);
            assertThat(hidden.get("primary").provenance()).isEqualTo(new Provenance("primary", "v1", ENTITY));
        }
        try (var runtime = open()) {
            var retry = runtime.apply(low);
            assertThat(retry.status()).isEqualTo("duplicate");
            assertThat(retry.reason()).isEqualTo("alreadyCommitted");
            assertThat(retry.version()).isEqualTo(1L);
            assertThat(retry.targets()).isEqualTo(original.targets());
            assertThat(runtime.apply(event("backup", 2, "score", "19")).reason()).isEqualTo("identityConflict");
            assertThat(runtime.apply(event("primary", 2, "label", "5")).version()).isEqualTo(3L);
            var position = runtime.snapshot("position", ENTITY).orElseThrow();
            assertThat(position.data().get("chosen").at("/payload/value").intValue()).isEqualTo(7);
            assertThat(position.provenance().get("chosen").sourceId()).isEqualTo("primary");
            assertThat(position.version()).isEqualTo(3L);
            assertThat(runtime.apply(event("backup", 1, "score", "9")).version()).isEqualTo(4L);
            assertThat(runtime.apply(event("backup", 3, "score", "11")).reason()).isEqualTo("historyLimit");
            assertThat(runtime.apply(event("primary", 6, "unmatched", "0")).version()).isEqualTo(5L);
        }
        try (var runtime = open()) {
            assertThat(runtime.apply(high).reason()).isEqualTo("outsideRetention");
            assertThat(runtime.apply(event("primary", 6, "unmatched", "0")).targets()).isEmpty();
            var trail = runtime.snapshot("trail", ENTITY).orElseThrow();
            assertThat(trail.version()).isEqualTo(4L);
            assertThat(trail.data().get("recent").path("publicationSequence").longValue()).isEqualTo(1L);
            assertThat(trail.data().get("history")).extracting(node -> node.path("publicationSequence").longValue())
                    .containsExactly(1L, 2L);
            assertThat(trail.data().get("history").at("/1/payload/value").decimalValue()).isEqualByComparingTo(PRECISE);
            assertThat(runtime.advance(new ProgressControl("primary", "v1", ENTITY, 7)).status()).isEqualTo("rejected");
            assertThat(runtime.retire(new FactRetirement("position", ENTITY, List.of("chosen"), 2)).status()).isEqualTo("rejected");
            assertThat(runtime.apply(event("primary", 7, "unmatched", "0")).version()).isEqualTo(6L);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void uncertainCommitStopsReadsAndWritesAndReloadDeterminesRetry(boolean committed) throws SQLException {
        var armed = new AtomicBoolean();
        var input = event("backup", 1, "score", PRECISE);
        try (var runtime = new AdmittedPostgresRuntime(binding, () -> db.interruptCommit(armed, committed))) {
            armed.set(true);
            assertThatThrownBy(() -> runtime.apply(input)).isInstanceOf(StorageUnavailable.class);
            assertThatThrownBy(() -> runtime.snapshot("trail", ENTITY)).isInstanceOf(StorageUnavailable.class);
            assertThatThrownBy(() -> runtime.apply(input)).isInstanceOf(StorageUnavailable.class);
        }
        db.expireLease(); // An uncertain owner leaves release to database expiry.
        try (var runtime = open()) {
            var before = runtime.snapshot("trail", ENTITY).orElseThrow();
            assertThat(before.version()).isEqualTo(committed ? 1L : 0L);
            var retry = runtime.apply(input);
            assertThat(retry.status()).isEqualTo(committed ? "duplicate" : "committed");
            assertThat(retry.reason()).isEqualTo(committed ? "alreadyCommitted" : "postgresql");
            assertThat(retry.version()).isEqualTo(1L);
            assertThat(retry.targets()).extracting(TargetOutcome::viewId).containsExactly("position", "trail");
            assertThat(runtime.snapshot("trail", ENTITY).orElseThrow().data().get("recent")
                    .at("/payload/value").decimalValue()).isEqualByComparingTo(PRECISE);
        }
    }

    @Test
    void incompatibleIdentitySchemaAndDeliveryCannotAdoptOrOverwriteInstalledState() throws Exception {
        var input = event("backup", 1, "score", "1");
        try (var first = open()) {
            first.apply(input);
        }
        var delivery = new RuntimeConfiguration.Delivery(null, SlowClientPolicy.select("coalesceLatestState"), 5, 4096L);
        var differentEpoch = new RuntimeConfiguration.Source("backup", "v2");
        for (var incompatible : List.of(
                new HaStaticProfile("different", binding.tenant(), config()),
                new HaStaticProfile(binding.runtimeId(), null, config()),
                new HaStaticProfile(binding.runtimeId(), "another", config()),
                profile(config(List.of(PRIMARY, BACKUP), List.of(TRAIL), null)),
                profile(config(List.of(PRIMARY, differentEpoch), List.of(TRAIL, POSITION), null)),
                profile(config(List.of(PRIMARY, BACKUP), List.of(TRAIL, POSITION), delivery)))) {
            assertThatThrownBy(() -> new AdmittedPostgresRuntime(incompatible, db::open))
                    .isInstanceOf(IllegalStateException.class);
        }
        db.execute("UPDATE zooglass_runtime SET schema_version=99");
        assertThatThrownBy(this::open).isInstanceOf(IllegalStateException.class);
        db.execute("UPDATE zooglass_runtime SET schema_version=2");
        try (var restored = open()) {
            assertThat(restored.apply(input).reason()).isEqualTo("alreadyCommitted");
        }
        db.execute("DELETE FROM zooglass_runtime");
        assertThatThrownBy(this::open).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsDamagedImagesIncludingLostHiddenEvidence() throws Exception {
        try (var runtime = open()) {
            runtime.apply(event("backup", 1, "score", "3"));
            runtime.apply(event("primary", 1, "score", "7"));
        }
        String saved;
        try (var conn = db.open(); var read = conn.createStatement();
                var row = read.executeQuery("SELECT image FROM zooglass_runtime")) {
            row.next();
            saved = row.getString(1);
        }
        for (String corruption : List.of("missing views", "missing hidden candidate", "hidden payload", "history payload", "duplicate stream",
                "aliased receipt key", "receipt wall time", "fact metadata", "unknown column", "lost targets")) {
            var image = (ObjectNode) StateRowJson.JSON.readTree(saved);
            var streams = (ArrayNode) image.path("streams");
            var views = (ArrayNode) image.path("views");
            var receipt = (ObjectNode) streams.get(0).at("/state/receipts/1");
            switch (corruption) {
                case "missing views" -> views.removeAll();
                case "missing hidden candidate" -> {
                    var position = view(views, "position");
                    ((ObjectNode) position.at("/state/candidates/chosen")).remove("backup");
                }
                case "hidden payload" -> {
                    var position = view(views, "position");
                    ((ObjectNode) position.at("/state/candidates/chosen/backup/value/payload")).put("value", 4);
                }
                case "history payload" -> {
                    var trail = view(views, "trail");
                    // Keep candidate and selected value consistent; only the retained receipt contradicts them.
                    ((ObjectNode) trail.at("/state/candidates/history/backup/value/0/payload")).put("value", 4);
                    ((ObjectNode) trail.at("/state/data/history/0/payload")).put("value", 4);
                }
                case "duplicate stream" -> streams.add(streams.get(0).deepCopy());
                case "aliased receipt key" -> ((ObjectNode) streams.get(0).at("/state/receipts")).set("01", receipt);
                case "receipt wall time" -> image.put("lastWallMillis", 123);
                case "fact metadata" -> receipt.set("fact", StateRowJson.JSON.readTree(
                        "{\"operation\":\"create\",\"birthSequence\":1,\"revision\":1}"));
                case "unknown column" -> image.put("futureState", 1);
                case "lost targets" -> ((ArrayNode) receipt.path("targets")).removeAll();
                default -> throw new AssertionError(corruption);
            }
            db.expireLease();
            replaceImage(image);
            assertThatThrownBy(this::open).as(corruption).isInstanceOf(IllegalStateException.class);
        }
        db.expireLease();
        replaceImage(StateRowJson.JSON.readTree(saved));
        try (var restored = open()) {
            assertThat(restored.apply(event("backup", 1, "score", "3")).reason()).isEqualTo("alreadyCommitted");
        }
    }

    private static JsonNode view(ArrayNode views, String id) {
        return views.valueStream().filter(row -> id.equals(row.at("/key/viewId").asText())).findFirst().orElseThrow();
    }

    private void replaceImage(JsonNode image) throws SQLException {
        try (var conn = db.open(); var change = conn.prepareStatement("UPDATE zooglass_runtime SET image=?")) {
            change.setString(1, StateRowJson.JSON.writeValueAsString(image));
            assertThat(change.executeUpdate()).isEqualTo(1);
        }
    }

    @Test
    void temporaryCopyAndChangedSearchPathCannotRedirectRestoreOrInstall() throws Exception {
        var first = event("backup", 1, "score", "3");
        var second = event("primary", 1, "score", "7");
        try (var runtime = open()) {
            runtime.apply(first);
        }
        try (var connection = db.open(); var sql = connection.createStatement()) {
            // Copy a valid binding and image, then advance only the authoritative table.
            sql.execute("CREATE TEMP TABLE zooglass_runtime AS TABLE zooglass_runtime");
            try (var runtime = open()) {
                runtime.apply(second);
            }
            try (var restored = new AdmittedPostgresRuntime(binding, () -> connection)) {
                assertThat(restored.apply(second).reason()).isEqualTo("alreadyCommitted");
                sql.execute("SET search_path TO pg_temp");
                var outcome = restored.apply(event("primary", 2, "label", "9"));
                assertThat(outcome.reason()).isEqualTo("postgresql");
                assertThat(outcome.version()).isEqualTo(3);
                try (var row = sql.executeQuery("SELECT revision FROM pg_temp.zooglass_runtime")) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getLong(1)).isEqualTo(1);
                }
            }
        }
        try (var recovered = open()) {
            assertThat(recovered.apply(event("primary", 2, "label", "9")).reason()).isEqualTo("alreadyCommitted");
        }
    }

    @Test
    void competingOpenCannotOverwriteTheCommittedWinner() {
        try (var first = open()) {
            first.apply(event("backup", 1, "score", "1"));
            assertThatThrownBy(this::open).isInstanceOf(StorageUnavailable.class);
        }
        try (var recovered = open()) {
            assertThat(recovered.apply(event("backup", 1, "score", "1")).reason()).isEqualTo("alreadyCommitted");
            assertThat(recovered.apply(event("backup", 1, "score", "2")).reason()).isEqualTo("identityConflict");
        }
    }
}
