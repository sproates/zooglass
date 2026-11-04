package io.zooglass.v2;

import io.zooglass.v2.StateImage.StoredView;
import io.zooglass.v2.StateImage.StreamState;
import io.zooglass.v2.StateImage.ViewEntity;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.json.JsonMapper;
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
    private static final int SCHEMA_VERSION = 2;
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
                var previous = JSON.readValue(metadata.getString(2), V2Configuration.class);
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
        var restored = new StateImage(version, Map.copyOf(streams), Map.copyOf(views));
        RecoveryValidation.image(restored, configuration);
        try (var update = connection.prepareStatement(
                "INSERT OR REPLACE INTO runtime(id, version, configuration) VALUES(1, ?, ?)")) {
            update.setLong(1, version);
            update.setString(2, JSON.writeValueAsString(configuration));
            update.executeUpdate();
        }
        if (schema == 1) {
            // Rewrite the enriched rows and schema marker in the same startup transaction.
            writeChanges(StateImage.empty(), restored);
            try (var statement = connection.createStatement()) {
                statement.execute("PRAGMA user_version=" + SCHEMA_VERSION);
            }
        }
        return restored;
    }

    private int initialiseSchema() throws SQLException {
        try (var statement = connection.createStatement()) {
            int version;
            try (var result = statement.executeQuery("PRAGMA user_version")) {
                result.next();
                version = result.getInt(1);
            }
            if (version == SCHEMA_VERSION || version == 1) {
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
            statement.execute("PRAGMA user_version=" + SCHEMA_VERSION);
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
        try (var update = connection.prepareStatement("UPDATE runtime SET version=? WHERE id=1")) {
            update.setLong(1, next.version());
            if (update.executeUpdate() != 1) {
                throw new SQLException("Missing runtime metadata");
            }
        }
    }
}
