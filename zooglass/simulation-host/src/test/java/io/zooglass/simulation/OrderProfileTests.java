package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
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

class OrderProfileTests {
    @TempDir Path directory;

    @Test void acceptedConfigurationHasAnExplicitHostOnlyCapability() throws Exception {
        assertThat(TimelineProfile.inspect(TimelineRuntime.inspectConfiguration(
                OrderTestSupport.configuration().toString()))).isEqualTo("sqlite-order-v1");
        assertThat(HostProtocol.V2.handshake("hash", "3")).containsEntry("sqliteOrder", 1);
        assertThat(HostProtocol.V2.handshake("hash", null)).doesNotContainKey("sqliteOrder");
        assertThat(HostProtocol.V1.handshake("hash", null)).doesNotContainKey("sqliteOrder");
        var response = JSON.valueToTree(new TimelineHost(HostProtocol.V1, false).command(
                OrderTestSupport.turn("inspect-configuration", 0)
                        .put("wire", OrderTestSupport.configuration().toString())));
        assertThat(response.path("configuration").path("documentProfile").asString()).isEqualTo("sqlite-order-v1");
        assertThat(response.path("effects").size()).isZero();
        assertThat(response.path("pendingTasks").intValue()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"memory", "streams", "identities", "history", "ranges", "start", "freshness",
            "mapping", "pending", "fields", "sources", "views", "arrival", "matchers", "messages", "bytes", "history-mode", "facts", "sum", "missing-ranges"})
    void validButWiderConfigurationsAreNotAdmitted(String change) throws Exception {
        var config = OrderTestSupport.configuration();
        var field = (ObjectNode) config.at("/views/0/fields/inventory");
        switch (change) {
            case "memory" -> config.put("storage", "memory");
            case "streams" -> config.put("maxStreams", 65);
            case "identities" -> config.put("identityWindow", 129);
            case "history" -> config.put("maxHistoryEntries", 65);
            case "ranges" -> ((ObjectNode) config.at("/sources/0/progress")).put("maxReceivedRanges", 65);
            case "start" -> ((ObjectNode) config.at("/sources/0/progress")).put("startSequence", 2);
            case "freshness" -> ((ObjectNode) field.path("freshness")).put("staleAfterMillis", 15001);
            case "mapping" -> ((ObjectNode) config.at("/views/0/entities/payments/keys")).put("extra", "extra-order");
            case "pending" -> ((ObjectNode) config.at("/views/1/publication")).put("maxPendingEntities", 7);
            case "fields" -> ((ObjectNode) config.at("/views/0/fields")).set("extra", field.deepCopy());
            case "sources" -> config.withArray("sources").addObject().put("id", "extra").put("epoch", "run");
            case "views" -> config.withArray("views").add(((ObjectNode) config.path("views").get(0).deepCopy()).put("id", "extra"));
            case "arrival" -> field.put("mode", "arrival");
            case "history-mode" -> field.put("mode", "historyBySequence");
            case "missing-ranges" -> ((ObjectNode) config.at("/sources/0/progress")).put("maxMissingRanges", 65);
            case "facts", "sum" -> {
                field.put("mode", change.equals("sum") ? "sumActiveFacts" : "activeFacts");
                field.remove("freshness");
                field.set("facts", JSON.createObjectNode().put("revision", "latestFactRevision")
                        .put("maxRetainedFacts", 16).put("minimumBirthSequence", 1));
                if (change.equals("sum")) field.put("property", "points");
            }
            case "matchers" -> {
                field.remove("sourceId");
                field.remove("type");
                field.set("inputs", JSON.readTree("""
                        [{"sourceId":"inventory","type":"inventory.state"},
                         {"sourceId":"inventory","type":"inventory.other"}]
                        """));
            }
            case "messages" -> config.set("delivery", JSON.createObjectNode().put("maxQueuedMessages", 129));
            case "bytes" -> config.set("delivery", JSON.createObjectNode().put("maxQueuedBytes", 1_048_577));
            default -> throw new AssertionError(change);
        }
        assertThat(TimelineProfile.inspect(TimelineRuntime.inspectConfiguration(config.toString()))).isEqualTo("unsupported");
    }

    @ParameterizedTest
    @ValueSource(strings = {"profile", "generation", "start", "offset", "existing", "unavailable", "v1"})
    void unsupportedInitializationCannotOpenOrRecoverAStore(String change) throws Exception {
        var database = directory.resolve(change + ".db");
        var command = OrderTestSupport.initialization(database);
        if (change.equals("profile")) command.remove("profile");
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
}
