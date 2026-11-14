package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.OrderTestSupport.turn;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.runtime.TimelineProfile;
import io.zooglass.runtime.TimelineRuntime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;

class SportsProfileTests {
    @TempDir Path directory;

    @Test void pinnedSportsConfigurationHasAnExplicitSqliteOnlyCapability() throws Exception {
        try (var input = getClass().getResourceAsStream("/sports-runtime.json")) {
            assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input.readAllBytes())))
                    .isEqualTo("775781cbf4e64abfb9a4a7ea1c61f8e7f904d3e743f5e8e660bec536e9e367ae");
        }
        assertThat(TimelineProfile.inspect(TimelineRuntime.inspectConfiguration(
                SportsTestSupport.configuration().toString()))).isEqualTo("sqlite-sports-v1");
        assertThat(HostProtocol.V2.handshake("hash", "3")).containsEntry("sqliteSports", 1);
        assertThat(HostProtocol.V2.handshake("hash", null)).doesNotContainKey("sqliteSports");
        assertThat(HostProtocol.V1.handshake("hash", null)).doesNotContainKey("sqliteSports");
        var result = JSON.valueToTree(new TimelineHost(HostProtocol.V1, false).command(
                turn("inspect-configuration", 0).put("wire", SportsTestSupport.configuration().toString())));
        assertThat(result.at("/configuration/documentProfile").asString()).isEqualTo("sqlite-sports-v1");
        assertThat(result.path("effects").size()).isZero();
        assertThat(result.path("pendingTasks").intValue()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"memory", "streams", "identities", "history", "received-ranges", "missing-ranges",
            "start", "untracked", "freshness", "mapping", "required", "fields-per-view", "fields-total", "sources", "views",
            "arrival", "history-mode", "property", "fact-capacity", "fact-floor", "matchers", "messages", "bytes",
            "conflict", "late-policy", "fact-freshness"})
    void widerConfigurationsRemainUnsupported(String change) throws Exception {
        var config = SportsTestSupport.configuration();
        var field = (ObjectNode) config.at("/views/0/fields/market");
        switch (change) {
            case "memory" -> config.put("storage", "memory");
            case "streams" -> config.put("maxStreams", 17);
            case "identities" -> config.put("identityWindow", 129);
            case "history" -> config.put("maxHistoryEntries", 65);
            case "received-ranges" -> ((ObjectNode) config.at("/sources/0/progress")).put("maxReceivedRanges", 17);
            case "missing-ranges" -> ((ObjectNode) config.at("/sources/0/progress")).put("maxMissingRanges", 17);
            case "start" -> ((ObjectNode) config.at("/sources/0/progress")).put("startSequence", 2);
            case "untracked" -> ((ObjectNode) config.at("/sources/0")).set("progress", JSON.createObjectNode().put("mode", "untracked"));
            case "freshness" -> ((ObjectNode) field.path("freshness")).put("staleAfterMillis", 15001);
            case "mapping" -> ((ObjectNode) config.at("/views/0/entities")).set("bookmaker", JSON.readTree(
                    "{\"mode\":\"lookupEntity\",\"keys\":{\"market-1\":\"match-1\"}}"));
            case "required" -> ((ObjectNode) config.path("views").get(0)).set("publication", JSON.readTree(
                    "{\"mode\":\"requireContributions\",\"fields\":[\"market\"],\"maxPendingEntities\":1}"));
            case "fields-per-view" -> {
                ((ObjectNode) config.at("/views/0/fields")).set("extra", field.deepCopy());
                ((ObjectNode) config.at("/views/1/fields")).remove("match");
            }
            case "fields-total" -> ((ObjectNode) config.at("/views/1/fields"))
                    .set("extra", config.at("/views/1/fields/match").deepCopy());
            case "sources" -> config.withArray("sources").addObject().put("id", "extra").put("epoch", "run");
            case "views" -> config.withArray("views").add(((ObjectNode) config.path("views").get(0).deepCopy()).put("id", "extra"));
            case "arrival" -> field.put("mode", "arrival");
            case "history-mode" -> field.put("mode", "historyBySequence");
            case "property" -> ((ObjectNode) config.at("/views/0/fields/homeScore")).put("property", "other");
            case "fact-capacity" -> ((ObjectNode) config.at("/views/0/fields/homeGoals/facts")).put("maxRetainedFacts", 17);
            case "fact-floor" -> ((ObjectNode) config.at("/views/0/fields/homeGoals/facts")).put("minimumBirthSequence", 2);
            case "conflict" -> field.set("conflict", JSON.readTree(
                    "{\"mode\":\"sourcePriority\",\"sources\":[\"bookmaker\"]}"));
            case "late-policy" -> field.set("late", JSON.createObjectNode().put("mode", "rejectBehindWatermark"));
            case "fact-freshness" -> ((ObjectNode) config.at("/views/0/fields/homeGoals")).set("freshness",
                    JSON.createObjectNode().put("mode", "receiptAge").put("staleAfterMillis", 15000));
            case "matchers" -> {
                field.remove("sourceId"); field.remove("type");
                field.set("inputs", JSON.readTree("""
                        [{"sourceId":"bookmaker","type":"market.state"},
                         {"sourceId":"bookmaker","type":"market.other"}]
                        """));
            }
            case "messages" -> config.set("delivery", JSON.createObjectNode().put("maxQueuedMessages", 129));
            case "bytes" -> config.set("delivery", JSON.createObjectNode().put("maxQueuedBytes", 1_048_577));
            default -> throw new AssertionError(change);
        }
        assertThat(TimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString()))).isEqualTo("unsupported");
    }

    @ParameterizedTest
    @ValueSource(strings = {"profile", "relabel", "generation", "start", "offset", "existing", "unavailable", "v1"})
    void unsupportedInitializationCannotOpenOrRecoverAStore(String change) throws Exception {
        var database = directory.resolve(change + ".db");
        var command = SportsTestSupport.initialization(database);
        if (change.equals("profile")) command.remove("profile");
        if (change.equals("relabel")) command.put("wire", OrderTestSupport.configuration().toString());
        if (change.equals("generation")) command.put("runtimeGeneration", 2);
        if (change.equals("start")) command.put("startTimeMs", 5).put("timeMs", 5).put("monotonicMs", 0)
                .put("wallMillis", OrderTestSupport.EPOCH + 5);
        if (change.equals("offset")) command.put("wallOffsetMillis", 1).put("wallMillis", OrderTestSupport.EPOCH + 1);
        if (change.equals("existing")) Files.writeString(database, "preserved");
        var protocol = change.equals("v1") ? HostProtocol.V1 : HostProtocol.V2;
        assertThatThrownBy(() -> new TimelineHost(protocol, !change.equals("unavailable")).command(command))
                .isInstanceOf(IllegalArgumentException.class);
        if (change.equals("existing")) assertThat(Files.readString(database)).isEqualTo("preserved");
        else assertThat(database).doesNotExist();
    }

    @Test void retirementCannotBeUsedOnOrderOrOnTheWrongSessionRole() throws Exception {
        var order = new OrderTestSupport();
        var sports = new SportsTestSupport();
        try {
            order.start(directory.resolve("order.db"));
            assertThatThrownBy(() -> order.connect("control", "retirement")).hasMessageContaining("Sports profile");
            sports.start(directory.resolve("sports.db"));
            sports.connect("source", "source");
            assertThatThrownBy(() -> sports.call(turn("retirement", 0).put("session", "source")
                    .put("wire", SportsTestSupport.control("scoreboard", 2, "homeScore"))))
                    .hasMessageContaining("Unavailable session");
            assertThatThrownBy(() -> sports.call(turn("wall-clock-set", 0)))
                    .hasMessageContaining("wall-clock adjustments");
        } finally {
            // Invalid host commands are fatal, so there is no follow-up shutdown turn.
            closeRuntime(order.host);
            closeRuntime(sports.host);
        }
    }

    static void closeRuntime(TimelineHost host) throws Exception {
        var field = TimelineHost.class.getDeclaredField("runtime");
        field.setAccessible(true);
        var runtime = (AutoCloseable) field.get(host);
        if (runtime != null) runtime.close();
    }
}
