package io.zooglass.runtime;

import java.security.MessageDigest;
import java.sql.SQLException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;

/** Non-serving control child: a capture has no public bytes, and no handoff is attempted. */
final class PostgresFenceScenario {
    static final String PREFIX = "HA_FENCE_OBSERVATION ";
    static final int INVARIANT_FAILURE = 77;
    private static final HaStaticProfile PROFILE = HaStaticProfileTests.profile(HaStaticProfileTests.config());

    private record Row(UUID incarnation, UUID attempt, long generation, long revision, String role, boolean leased, String image) {}
    private record Observation(String scenario, String classSha256, long capturedGeneration, long databaseGeneration,
            long cachedRevision, long databaseRevision, boolean ownerChanged, String captureResult,
            String invariant, boolean invariantPassed) {}

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("One control scenario is required");
        Observation observation;
        try (var db = new PostgresTestDatabase(); var owner = activate(db)) {
            var initial = row(db);
            require(initial.generation == 1 && initial.revision == 0 && owner.servingReady(), "Original owner not active");
            observation = switch (args[0]) {
                case "owner" -> takeover(db, owner, initial);
                case "revision" -> cacheDrift(db, owner, initial);
                default -> throw new IllegalArgumentException("Unknown control scenario");
            };
        }
        // Only an observed invariant failure AFTER successful scenario cleanup returns 77.
        System.out.println(PREFIX + StateRowJson.JSON.writeValueAsString(observation));
        if (!observation.invariantPassed) System.exit(INVARIANT_FAILURE);
    }

    private static Observation takeover(PostgresTestDatabase db, OwnedRuntime former, Row initial) throws Exception {
        db.expireLease();
        try (var successor = activate(db)) {
            var current = row(db);
            require(initial.incarnation.equals(current.incarnation) && !initial.attempt.equals(current.attempt)
                    && current.generation == initial.generation + 1 && current.revision == initial.revision
                    && successor.servingReady(), "Expected a real takeover at the original revision");
            return check("owner", "former-owner-capture-refused", "Runtime authority lost", db, former, initial, current);
        }
    }

    private static Observation cacheDrift(PostgresTestDatabase db, OwnedRuntime owner, Row initial) throws Exception {
        // Model a stale installed cache under the same identity. Inject a COMPLETE real committed
        // image/revision pair from a second schema with this exact immutable runtime configuration.
        Row committed;
        try (var donor = new PostgresTestDatabase(); var writer = activate(donor)) {
            writer.publish(new Publication("backup", "v1", "car", 1, "score", StateRowJson.JSON.readTree("{\"value\":7}")));
            committed = row(donor);
            require(committed.revision == 1 && !committed.image.equals(initial.image), "Donor did not commit its publication");
        }
        try (var connection = db.open(); var update = connection.prepareStatement("""
                UPDATE zooglass_runtime SET image=?,revision=?
                WHERE singleton=1 AND incarnation=? AND attempt=? AND generation=? AND revision=?
                """)) {
            update.setString(1, committed.image);
            update.setLong(2, committed.revision);
            update.setObject(3, initial.incarnation);
            update.setObject(4, initial.attempt);
            update.setLong(5, initial.generation);
            update.setLong(6, initial.revision);
            require(update.executeUpdate() == 1, "Failed to inject the committed image");
        }
        var current = row(db);
        require(initial.incarnation.equals(current.incarnation) && initial.attempt.equals(current.attempt)
                && current.generation == initial.generation && current.revision == committed.revision
                && current.image.equals(committed.image), "Revision fault did not preserve the active owner and committed image");
        return check("revision", "stale-cache-capture-refused", "PostgreSQL revision conflict", db, owner, initial, current);
    }

    private static Observation check(String scenario, String invariant, String reason, PostgresTestDatabase db,
            OwnedRuntime candidate, Row initial, Row current) throws Exception {
        String result;
        try {
            candidate.snapshot("trail", "car");
            result = "accepted";
        } catch (StorageUnavailable refused) {
            if (!(refused.getCause() instanceof SQLException sql) || !reason.equals(sql.getMessage())) throw refused;
            result = "refused";
        }
        require(current.equals(row(db)), "Capture changed authority, revision or image");
        return new Observation(scenario, authorityHash(), initial.generation, current.generation,
                initial.revision, current.revision, !initial.attempt.equals(current.attempt),
                result, invariant, result.equals("refused"));
    }

    private static OwnedRuntime activate(PostgresTestDatabase db) {
        var owner = ViewCoordinator.postgres(PROFILE, db::open, Duration.ofSeconds(30));
        try {
            owner.recover();
            owner.activate();
            return owner;
        } catch (RuntimeException failure) {
            owner.close();
            throw failure;
        }
    }

    private static Row row(PostgresTestDatabase db) throws SQLException {
        try (var connection = db.open(); var sql = connection.createStatement();
                var result = sql.executeQuery("""
                        SELECT incarnation,attempt,generation,revision,role,lease_until > clock_timestamp(),image
                        FROM zooglass_runtime WHERE singleton=1
                        """)) {
            require(result.next(), "Missing authority row");
            var row = new Row(result.getObject(1, UUID.class), result.getObject(2, UUID.class), result.getLong(3),
                    result.getLong(4), result.getString(5), result.getBoolean(6), result.getString(7));
            require("active".equals(row.role) && row.leased && !result.next(), "Expected one active leased row");
            return row;
        }
    }

    private static String authorityHash() throws Exception {
        try (var input = PostgresAuthority.class.getResourceAsStream("PostgresAuthority.class")) {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.readAllBytes()));
        }
    }

    private static void require(boolean valid, String message) {
        if (!valid) throw new IllegalStateException(message);
    }
}
