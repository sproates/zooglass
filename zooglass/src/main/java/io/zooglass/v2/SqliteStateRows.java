package io.zooglass.v2;

import io.zooglass.v2.StateImage.StoredView;
import io.zooglass.v2.StateImage.StreamState;
import io.zooglass.v2.StateImage.ViewEntity;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;
import tools.jackson.databind.type.LogicalType;
import tools.jackson.databind.cfg.CoercionInputShape;
import tools.jackson.databind.cfg.CoercionAction;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.Map;
import java.util.List;

/** Schema and row encoding. Transaction boundaries belong to SqliteState. */
final class SqliteStateRows {
    private static final int PROGRESS_SCHEMA = 4;
    private static final int RECEIPT_AGE_SCHEMA = 5;
    private static final int FACT_SCHEMA = 6;
    private static final JsonMapper JSON = JsonMapper.builder()
            .withCoercionConfig(LogicalType.Textual, coercion -> {
                for (var shape : List.of(CoercionInputShape.Integer,
                        CoercionInputShape.Float, CoercionInputShape.Boolean)) {
                    coercion.setCoercion(shape, CoercionAction.Fail);
                }
            })
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    private final Connection connection;

    SqliteStateRows(Connection connection) {
        this.connection = connection;
    }

    StateImage restore(V2Configuration configuration) throws SQLException {
        int schema = initialiseSchema();
        boolean fresh = schema == 0;
        int targetSchema = configuration.tracksFacts() ? FACT_SCHEMA : configuration.tracksAge() ? RECEIPT_AGE_SCHEMA : PROGRESS_SCHEMA;
        if (schema > targetSchema) throw new SQLException("Stored freshness configuration is required");
        try (var statement = connection.createStatement();
                var check = statement.executeQuery("PRAGMA quick_check")) {
            if (!check.next() || !"ok".equals(check.getString(1))) {
                throw new SQLException("Database integrity check failed");
            }
        }

        long version = 0;
        try (var statement = connection.createStatement();
                var metadata = statement.executeQuery("SELECT version, configuration FROM runtime WHERE id=1")) {
            if (metadata.next()) {
                version = metadata.getLong(1);
                var previous = V2Configuration.decode(JSON, JSON.readTree(metadata.getString(2)));
                RecoveryValidation.configuration(previous, configuration);
            } else if (!fresh) {
                throw new SQLException("Missing runtime metadata");
            }
        }

        Map<Publication.StreamKey, StreamState> streams = new HashMap<>();
        try (var statement = connection.createStatement();
                var records = statement.executeQuery("SELECT source, epoch, entity, state FROM streams")) {
            while (records.next()) {
                var key = new Publication.StreamKey(records.getString(1), records.getString(2), records.getString(3));
                streams.put(key, JSON.readValue(records.getString(4), StreamState.class));
            }
        }

        Map<ViewEntity, StoredView> views = new HashMap<>();
        try (var statement = connection.createStatement();
                var records = statement.executeQuery("SELECT view, entity, state FROM views")) {
            while (records.next()) {
                var key = new ViewEntity(records.getString(1), records.getString(2));
                views.put(key, JSON.readValue(records.getString(3), StoredView.class));
            }
        }

        if (schema == 1) {
            views = SchemaMigration.addProvenance(views, configuration);
        }
        if (schema == 1 || schema == 2) {
            views = SchemaMigration.addCandidates(views);
        }
        Long lastWall = null;
        if (schema >= RECEIPT_AGE_SCHEMA) {
            try (var statement = connection.createStatement();
                    var row = statement.executeQuery("SELECT last_wall, typeof(last_wall) FROM runtime WHERE id=1")) {
                if (!row.next()) throw new SQLException("Missing receipt clock metadata");
                lastWall = row.getObject(1) == null ? null : row.getLong(1);
                if (lastWall != null && (!"integer".equals(row.getString(2)) || lastWall < 0)) {
                    throw new SQLException("Invalid receipt clock");
                }
            }
        } else if (targetSchema >= RECEIPT_AGE_SCHEMA) {
            try (var statement = connection.createStatement()) {
                statement.execute("ALTER TABLE runtime ADD COLUMN last_wall INTEGER");
            }
        }
        var restored = new StateImage(version, Map.copyOf(streams), Map.copyOf(views), lastWall);
        RecoveryValidation.image(restored, configuration);
        try (var update = connection.prepareStatement(
                "INSERT INTO runtime(id, version, configuration) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration")) {
            update.setLong(1, version);
            update.setString(2, encodeConfiguration(configuration));
            update.executeUpdate();
        }
        if (schema < targetSchema) {
            // Rewrite the enriched rows and schema marker in the same startup transaction.
            writeChanges(StateImage.empty(), restored);
            try (var statement = connection.createStatement()) {
                statement.execute("PRAGMA user_version=" + targetSchema);
            }
        }
        return restored;
    }

    private static String encodeConfiguration(V2Configuration configuration) {
        var document = (ObjectNode) JSON.valueToTree(configuration);
        for (var view : document.get("views")) {
            for (var field : view.get("fields")) {
                if ("unspecified".equals(field.at("/freshness/mode").asText())) {
                    ((ObjectNode) field).remove("freshness");
                }
            }
            // Schema-4 readers from before required views reject unknown properties.
            if ("publishPartial".equals(view.at("/publication/mode").asText())) {
                ((ObjectNode) view).remove("publication");
            }
        }
        return JSON.writeValueAsString(document);
    }

    private int initialiseSchema() throws SQLException {
        try (var statement = connection.createStatement()) {
            int version;
            try (var result = statement.executeQuery("PRAGMA user_version")) {
                result.next();
                version = result.getInt(1);
            }
            if (version >= 1 && version <= FACT_SCHEMA) {
                return version;
            }
            if (version != 0) {
                throw new SQLException("Unsupported v2 state schema");
            }
            try (var tables = statement.executeQuery(
                    "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
                if (tables.next() && tables.getInt(1) != 0) {
                    throw new SQLException("Refusing to initialise an unrecognised database");
                }
            }
            statement.execute("""
                    CREATE TABLE runtime(
                        id INTEGER PRIMARY KEY CHECK(id=1),
                        version INTEGER NOT NULL,
                        configuration TEXT NOT NULL)
                    """);
            statement.execute("""
                    CREATE TABLE streams(
                        source TEXT NOT NULL, epoch TEXT NOT NULL, entity TEXT NOT NULL,
                        state TEXT NOT NULL, PRIMARY KEY(source, epoch, entity))
                    """);
            statement.execute("""
                    CREATE TABLE views(
                        view TEXT NOT NULL, entity TEXT NOT NULL, state TEXT NOT NULL,
                        PRIMARY KEY(view, entity))
                    """);
            statement.execute("PRAGMA user_version=" + PROGRESS_SCHEMA);
            return 0;
        }
    }

    void writeChanges(StateImage previous, StateImage next) throws SQLException {
        try (var update = connection.prepareStatement(
                "INSERT OR REPLACE INTO streams(source, epoch, entity, state) VALUES(?, ?, ?, ?)")) {
            for (var entry : next.streams().entrySet()) {
                if (entry.getValue() == previous.streams().get(entry.getKey())) {
                    continue;
                }
                var key = entry.getKey();
                update.setString(1, key.sourceId());
                update.setString(2, key.epoch());
                update.setString(3, key.sourceEntityId());
                update.setString(4, JSON.writeValueAsString(entry.getValue()));
                update.executeUpdate();
            }
        }
        try (var update = connection.prepareStatement(
                "INSERT OR REPLACE INTO views(view, entity, state) VALUES(?, ?, ?)")) {
            for (var entry : next.views().entrySet()) {
                if (entry.getValue() == previous.views().get(entry.getKey())) {
                    continue;
                }
                update.setString(1, entry.getKey().viewId());
                update.setString(2, entry.getKey().entityId());
                update.setString(3, JSON.writeValueAsString(entry.getValue()));
                update.executeUpdate();
            }
        }
        String updateRuntime = next.lastWallMillis() == null ? "UPDATE runtime SET version=? WHERE id=1"
                : "UPDATE runtime SET version=?, last_wall=? WHERE id=1";
        try (var update = connection.prepareStatement(updateRuntime)) {
            if (next.lastWallMillis() != null) update.setLong(2, next.lastWallMillis());
            update.setLong(1, next.version());
            if (update.executeUpdate() != 1) {
                throw new SQLException("Missing runtime metadata");
            }
        }
    }
}
