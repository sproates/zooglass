package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.OrderTestSupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import java.nio.file.Path;
import java.util.List;

class OrderTimelineHostTests {
    @TempDir Path directory;

    @Test void progressIsDurableIdempotentAndChangesBothViewsWithoutReplacingData() throws Exception {
        try (var fixture = new OrderTestSupport()) {
            fixture.start(directory.resolve("progress.db"));
            fixture.connect("source", "source");
            fixture.connect("progress", "progress");
            fixture.publish(0, "orders", "order-1", "order.state", 1);
            fixture.publish(0, "inventory", "reservation-1", "inventory.state", 1);
            fixture.publish(0, "orders", "order-1", "order.state", 3);
            var before = fixture.snapshot("order-tracking", "order-1");
            assertThat(before.at("/status/inputs/orders/missingRanges")).isEqualTo(JSON.readTree(
                    "[{\"from\":2,\"through\":2,\"status\":\"provisional\"}]"));
            var confirmed = fixture.progress(0, "orders", "order-1", 3);
            assertThat(receipt(confirmed, "control-receipt")).isEqualTo(JSON.readTree("""
                    {"kind":"watermark","status":"committed","reason":"sqlite",
                     "stream":{"sourceId":"orders","epoch":"run","sourceEntityId":"order-1"},
                     "throughSequence":3,"version":4,"changedViews":["order-summary","order-tracking"]}
                    """));
            assertThat(states(confirmed).stream().map(s -> s.path("viewId").asString()))
                    .containsExactly("order-summary", "order-tracking");
            var after = fixture.snapshot("order-tracking", "order-1");
            assertThat(after.path("data")).isEqualTo(before.path("data"));
            var progress = after.at("/status/inputs/orders");
            assertThat(progress.path("watermarkThrough").longValue()).isEqualTo(3);
            assertThat(progress.path("completeThrough").isNull()).isTrue();
            assertThat(progress.path("missingRanges")).isEqualTo(JSON.readTree(
                    "[{\"from\":2,\"through\":2,\"status\":\"confirmed\"}]"));
            var duplicate = fixture.progress(0, "orders", "order-1", 3);
            var expected = receipt(confirmed, "control-receipt").deepCopy();
            ((tools.jackson.databind.node.ObjectNode) expected).put("status", "duplicate").put("reason", "alreadyCommitted")
                    .set("changedViews", JSON.createArrayNode());
            assertThat(receipt(duplicate, "control-receipt")).isEqualTo(expected);
            assertThat(duplicate.path("effects").size()).isOne();
            assertThat(receipt(fixture.progress(0, "orders", "order-1", 2), "control-receipt")
                    .path("reason").asString()).isEqualTo("backwardsWatermark");
            fixture.publish(0, "orders", "order-1", "order.state", 2);
            var repaired = fixture.snapshot("order-tracking", "order-1");
            assertThat(repaired.at("/status/inputs/orders/sourceContractViolated").booleanValue()).isTrue();
            assertThat(repaired.path("data")).isEqualTo(before.path("data"));
            assertThat(repaired.at("/status/inputs/orders/missingRanges").size()).isZero();
            assertThat(repaired.at("/status/inputs/orders/completeness").asString()).isEqualTo("violated");
        }
    }

    @Test void realParserRejectsMalformedAndInvalidControlsWithoutPublicationReceipts() throws Exception {
        try (var fixture = new OrderTestSupport()) {
            fixture.start(directory.resolve("invalid.db"));
            fixture.connect("progress", "progress");
            var invalid = fixture.call(turn("progress", 0).put("session", "progress").put("wire", "{}"));
            assertThat(receipt(invalid, "control-receipt")).isEqualTo(JSON.readTree("""
                    {"kind":"watermark","status":"rejected","reason":"invalidProgress",
                     "stream":null,"throughSequence":null,"version":null,"changedViews":[]}
                    """));
            assertThat(receipt(fixture.progress(0, "missing", "x", 1), "control-receipt").path("reason").asString())
                    .isEqualTo("unknownSource");
            assertThat(receipt(fixture.progress(0, "courier-backup", "tracking-1", 1), "control-receipt")
                    .path("reason").asString()).isEqualTo("progressUntracked");
        }
    }

    @Test void requiredMappingAndStalePriorityRemainProductionOwned() throws Exception {
        try (var fixture = new OrderTestSupport()) {
            fixture.start(directory.resolve("selection.db"));
            fixture.connect("source", "source");
            fixture.publish(0, "orders", "order-1", "order.state", 1);
            assertThat(fixture.snapshot("order-tracking", "order-1").at("/status/publication").asString()).isEqualTo("waiting");
            fixture.publish(0, "inventory", "reservation-1", "inventory.state", 1);
            assertThat(fixture.snapshot("order-tracking", "order-1").at("/status/publication").asString()).isEqualTo("partial");
            assertThat(fixture.snapshot("order-tracking", "order-1").at("/status/missingRequiredFields").size()).isZero();
            fixture.publish(0, "courier-backup", "tracking-1", "delivery.state", 20);
            fixture.publish(0, "courier-primary", "shipment-1", "delivery.state", 1);
            fixture.advance(14999);
            assertThat(fixture.snapshot("order-summary", "order-1").at("/status/fields/delivery/freshness").asString()).isEqualTo("fresh");
            fixture.advance(15000);
            assertThat(fixture.snapshot("order-summary", "order-1").at("/status/fields/delivery/freshness").asString())
                    .isEqualTo("stale");
            fixture.publish(15000, "courier-backup", "tracking-1", "delivery.state", 21);
            var selected = fixture.snapshot("order-summary", "order-1");
            assertThat(selected.at("/status/fields/delivery/freshness").asString()).isEqualTo("stale");
            assertThat(selected.at("/data/delivery/publicationSequence").longValue()).isOne();
            assertThat(selected.at("/status/fields/delivery/receivedAtMillis").longValue()).isEqualTo(EPOCH);
            var rejected = receipt(fixture.publish(15000, "payments", "payment-unmapped", "payment.state", 1), "receipt");
            assertThat(rejected.path("status").asString()).isEqualTo("committed");
            assertThat(rejected.path("targets").get(0).path("entityId").isNull()).isTrue();
            assertThat(rejected.path("targets").get(0).path("reason").asString()).isEqualTo("unknownEntityMapping");
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void progressEffectsRespectViewAndSubscriberOrder(boolean reverse) throws Exception {
        try (var fixture = new OrderTestSupport()) {
            var config = configuration();
            if (reverse) {
                var views = config.withArray("views");
                var first = views.remove(0);
                views.add(first);
            }
            fixture.call(initialization(directory.resolve("clients.db")).put("wire", config.toString()));
            fixture.connect("source", "source");
            fixture.connect("progress", "progress");
            fixture.publish(0, "orders", "order-1", "order.state", 1);
            fixture.publish(0, "inventory", "reservation-1", "inventory.state", 1);
            fixture.publish(0, "orders", "order-1", "order.state", 3);
            fixture.advance(0);
            var views = reverse ? List.of("order-tracking", "order-summary") : List.of("order-summary", "order-tracking");
            for (String client : List.of("z", "a")) {
                fixture.connect(client, "client");
                for (String view : views) {
                    fixture.call(turn("subscribe", 0).put("session", client).put("wire",
                            JSON.createObjectNode().put("action", "subscribe").put("viewId", view)
                                    .put("entityId", "order-1").toString()));
                    fixture.advance(0);
                }
            }
            var control = fixture.progress(0, "orders", "order-1", 3);
            assertThat(states(control).stream().map(s -> s.path("viewId").asString())).containsExactlyElementsOf(views);
            var frames = fixture.advance(0).stream().filter(e -> e.path("kind").asString().equals("frame")).toList();
            assertThat(frames.stream().map(e -> e.path("session").asString() + ":"
                    + JSON.readTree(e.path("wire").asString()).path("viewId").asString())).containsExactly(
                            "z:" + views.get(0), "a:" + views.get(0), "z:" + views.get(1), "a:" + views.get(1));
            for (var effect : frames) {
                var frame = JSON.readTree(effect.path("wire").asString());
                assertThat(frame.path("version").longValue()).isEqualTo(4);
                assertThat(frame.at("/data/order/status").asString()).isEqualTo("value-3");
                assertThat(frame.at("/status/inputs/orders/missingRanges")).isEqualTo(JSON.readTree(
                        "[{\"from\":2,\"through\":2,\"status\":\"confirmed\"}]"));
            }
        }
    }

    @Test void failedProgressStorageCannotAcknowledgeAHostTurn() throws Exception {
        var fixture = new OrderTestSupport();
        fixture.start(directory.resolve("failed.db"));
        fixture.connect("progress", "progress");
        var runtime = field(fixture.host, "runtime");
        // Fault injection stays in test code and uses the exclusively owned connection.
        var storage = field(runtime, "storage");
        var connection = (java.sql.Connection) field(storage, "connection");
        try (var statement = connection.createStatement()) {
            statement.execute("CREATE TRIGGER refuse_stream BEFORE INSERT ON streams "
                    + "BEGIN SELECT RAISE(ABORT, 'injected control failure'); END");
        }
        connection.commit();
        try {
            assertThatThrownBy(() -> fixture.progress(0, "orders", "order-1", 3))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("SQLite storage requires recovery");
        } finally {
            // A fatal host command has no next turn; release its resources directly as process exit would.
            ((AutoCloseable) runtime).close();
        }
    }

    private static Object field(Object owner, String name) throws Exception {
        var field = owner.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(owner);
    }

    private static List<JsonNode> states(JsonNode response) {
        return response.path("effects").valueStream().filter(e -> e.path("kind").asString().equals("state"))
                .map(e -> JSON.readTree(e.path("wire").asString())).toList();
    }
}
