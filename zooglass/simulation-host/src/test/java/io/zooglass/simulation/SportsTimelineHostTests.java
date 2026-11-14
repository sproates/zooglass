package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.JSON;
import static io.zooglass.simulation.OrderTestSupport.receipt;
import static io.zooglass.simulation.OrderTestSupport.turn;
import static io.zooglass.simulation.SportsTestSupport.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Path;
import java.util.List;

class SportsTimelineHostTests {
    @TempDir Path directory;

    @Test void createRevisionWithdrawalAndLateCreateUseTheActualFactPolicies() throws Exception {
        try (var fixture = new SportsTestSupport()) {
            fixture.start(directory.resolve("facts.db"));
            fixture.connect("source", "source");
            assertThat(fixture.snapshot("scoreboard").path("data").has("homeScore")).isFalse();
            String correction = fact(2, 1, 2, "revise", "{\"points\":0.125}");
            var rejected = receipt(fixture.publish(correction), "receipt");
            assertThat(rejected.path("reason").asString()).isEqualTo("unknownFact");
            assertThat(rejected.path("version").longValue()).isZero();
            assertThat(fixture.snapshot("scoreboard").at("/status/inputs/match-feed/observedThrough").isNull()).isTrue();
            fixture.publish(fact(3, 3, 1, "create", "{\"points\":0.2}"));
            fixture.publish(fact(1, 1, 1, "create", "{\"points\":0.1}"));
            var repaired = receipt(fixture.publish(correction), "receipt");
            assertThat(repaired.path("status").asString()).isEqualTo("committed");
            assertThat(repaired.path("version").longValue()).isEqualTo(3);
            assertThat(fixture.snapshot("scoreboard").at("/status/inputs/match-feed/missingRanges").size()).isZero();
            fixture.publish(fact(4, 1, 3, "revise", "{\"points\":0.125}"));
            var obsolete = receipt(fixture.publish(fact(5, 1, 2, "revise", "{\"points\":9}")), "receipt");
            assertThat(obsolete.path("status").asString()).isEqualTo("committed");
            assertThat(obsolete.path("targets").get(0).path("reason").asString()).isEqualTo("obsoleteRevision");
            assertThat(obsolete.path("targets").get(2).path("reason").asString()).isEqualTo("factImmutable");
            var corrected = fixture.snapshot("match-market");
            assertThat(corrected.at("/data/homeGoals")).isEqualTo(JSON.readTree("""
                    [{"birthSequence":1,"revision":3,"payload":{"points":0.125}},
                     {"birthSequence":3,"revision":1,"payload":{"points":0.2}}]
                    """));
            assertThat(corrected.at("/data/homeScore").decimalValue()).isEqualByComparingTo("0.325");
            assertThat(fixture.snapshot("first-reported").at("/data/homeScore").decimalValue()).isEqualByComparingTo("0.3");
            fixture.publish(fact(6, 1, 4, "retract", "{}"));
            fixture.publish(fact(7, 3, 2, "retract", "{}"));
            var zero = fixture.snapshot("match-market");
            assertThat(zero.at("/data/homeScore").intValue()).isZero();
            assertThat(zero.path("data").has("homeScore")).isTrue();
            assertThat(zero.at("/data/homeGoals").size()).isZero();
            assertThat(fixture.snapshot("first-reported").at("/data/homeScore").decimalValue()).isEqualByComparingTo("0.3");
        }
    }

    @Test void retirementIsAtomicPerViewAndEqualFloorsUseTheCurrentVersion() throws Exception {
        try (var fixture = new SportsTestSupport()) {
            fixture.start(directory.resolve("retire.db"));
            fixture.connect("source", "source");
            fixture.connect("retirement", "retirement");
            String original = fact(1, 1, 1, "create", "{\"points\":1}");
            fixture.publish(original);
            var other = fixture.snapshot("scoreboard");
            var retired = fixture.retire("match-market", 2, "homeScore", "homeGoals");
            assertThat(receipt(retired, "control-receipt")).isEqualTo(JSON.readTree("""
                    {"kind":"factRetirement","status":"committed","reason":null,
                     "control":{"viewId":"match-market","entityId":"match-1",
                        "fields":["homeGoals","homeScore"],"minimumBirthSequence":2},
                     "version":2,"floors":{"homeGoals":2,"homeScore":2},"changedViews":["match-market"]}
                    """));
            assertThat(states(retired).stream().map(s -> s.path("viewId").asString())).containsExactly("match-market");
            assertThat(fixture.snapshot("scoreboard")).isEqualTo(other);
            var beforeFailure = fixture.snapshot("match-market");
            assertThat(receipt(fixture.retire("match-market", 3, "homeGoals", "missing"), "control-receipt"))
                    .isEqualTo(JSON.readTree("""
                    {"kind":"factRetirement","status":"rejected","reason":"unknownFactField",
                     "control":{"viewId":"match-market","entityId":"match-1",
                        "fields":["homeGoals","missing"],"minimumBirthSequence":3},
                     "version":2,"floors":{},"changedViews":[]}
                    """));
            assertThat(fixture.snapshot("match-market")).isEqualTo(beforeFailure);
            var duplicate = receipt(fixture.publish(original), "receipt");
            assertThat(duplicate.path("status").asString()).isEqualTo("duplicate");
            assertThat(duplicate.path("version").longValue()).isOne();
            var late = receipt(fixture.publish(fact(2, 1, 2, "revise", "{\"points\":2}")), "receipt");
            assertThat(late.path("version").longValue()).isEqualTo(3);
            assertThat(late.path("targets").get(0).path("reason").asString()).isEqualTo("factOutsideRetention");
            var repeat = fixture.retire("match-market", 2, "homeGoals", "homeScore");
            assertThat(receipt(repeat, "control-receipt")).isEqualTo(JSON.readTree("""
                    {"kind":"factRetirement","status":"unchanged","reason":null,
                     "control":{"viewId":"match-market","entityId":"match-1",
                        "fields":["homeGoals","homeScore"],"minimumBirthSequence":2},
                     "version":3,"floors":{"homeGoals":2,"homeScore":2},"changedViews":[]}
                    """));
            assertThat(repeat.path("effects").size()).isOne();
            assertThat(receipt(fixture.retire("match-market", 1, "homeGoals", "homeScore"), "control-receipt")
                    .path("reason").asString()).isEqualTo("backwardsFactFloor");
            // Mixed existing floors must reject every field, including the otherwise forward one.
            fixture.retire("match-market", 4, "homeScore");
            var unequal = fixture.snapshot("match-market");
            assertThat(receipt(fixture.retire("match-market", 3, "homeGoals", "homeScore"), "control-receipt")
                    .path("reason").asString()).isEqualTo("backwardsFactFloor");
            assertThat(fixture.snapshot("match-market")).isEqualTo(unequal);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"{}", "{\"viewId\":\"scoreboard\",\"entityId\":\"match-1\",\"fields\":[\"homeScore\",\"homeScore\"],\"minimumBirthSequence\":2}",
            "{\"viewId\":\"scoreboard\",\"entityId\":\"match-1\",\"fields\":[\"homeScore\"],\"minimumBirthSequence\":9007199254740992}"})
    void invalidRetirementsReturnTheCompleteParserRejection(String wire) throws Exception {
        try (var fixture = new SportsTestSupport()) {
            fixture.start(directory.resolve("invalid.db"));
            fixture.connect("retirement", "retirement");
            var response = fixture.call(turn("retirement", 0).put("session", "retirement").put("wire", wire));
            assertThat(receipt(response, "control-receipt")).isEqualTo(JSON.readTree("""
                    {"kind":"factRetirement","status":"rejected","reason":"invalidFactRetirement",
                     "control":null,"version":null,"floors":{},"changedViews":[]}
                    """));
            assertThat(response.path("effects").size()).isOne();
        }
    }

    @Test void numericOverflowOnPublicationAndRetirementRollsBackAllFields() throws Exception {
        try (var fixture = new SportsTestSupport()) {
            fixture.start(directory.resolve("numbers.db"));
            fixture.connect("source", "source");
            fixture.connect("retirement", "retirement");
            String maximum = "9".repeat(38);
            fixture.publish(fact(1, 1, 1, "create", "{\"points\":-1}"));
            fixture.publish(fact(2, 2, 1, "create", "{\"points\":" + maximum + "}"));
            fixture.publish(fact(3, 3, 1, "create", "{\"points\":1}"));
            var before = fixture.snapshot("match-market");
            assertThat(before.at("/data/homeScore").decimalValue()).isEqualByComparingTo(maximum);
            assertThat(receipt(fixture.publish(fact(4, 4, 1, "create", "{\"points\":1}")), "receipt")
                    .path("reason").asString()).isEqualTo("numericRange");
            var rejected = fixture.retire("match-market", 2, "homeGoals", "homeScore");
            assertThat(receipt(rejected, "control-receipt")).isEqualTo(JSON.readTree("""
                    {"kind":"factRetirement","status":"rejected","reason":"numericRange",
                     "control":{"viewId":"match-market","entityId":"match-1",
                        "fields":["homeGoals","homeScore"],"minimumBirthSequence":2},
                     "version":3,"floors":{},"changedViews":[]}
                    """));
            assertThat(fixture.snapshot("match-market")).isEqualTo(before);
            assertThat(receipt(fixture.publish(fact(4, 4, 1, "create", "{\"points\":-1}")), "receipt")
                    .path("version").longValue()).isEqualTo(4);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"1e38", "1e-19", "\"1\""})
    void numericBoundsRejectWithoutConsumingThePublicationIdentity(String number) throws Exception {
        try (var fixture = new SportsTestSupport()) {
            fixture.start(directory.resolve("bounds.db"));
            fixture.connect("source", "source");
            var result = receipt(fixture.publish(fact(1, 1, 1, "create", "{\"points\":" + number + "}")), "receipt");
            assertThat(result.path("reason").asString()).isEqualTo(number.startsWith("\"") ? "invalidNumericContribution" : "numericRange");
            assertThat(fixture.snapshot("scoreboard").path("data").has("homeScore")).isFalse();
            assertThat(receipt(fixture.publish(fact(1, 1, 1, "create", "{\"points\":1e-18}")), "receipt")
                    .path("version").longValue()).isOne();
            assertThat(fixture.snapshot("scoreboard").at("/data/homeScore").decimalValue()).isEqualByComparingTo("0.000000000000000001");
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void factEffectsAndRetirementDeliveryPreserveDeclaredViewAndConnectionOrder(boolean reverse) throws Exception {
        try (var fixture = new SportsTestSupport()) {
            var config = configuration();
            if (reverse) {
                var definitions = config.withArray("views");
                var first = definitions.remove(0); definitions.add(first);
                var fields = (ObjectNode) config.at("/views/2/fields");
                var home = fields.remove("homeGoals"); fields.set("homeGoals", home);
            }
            fixture.call(initialization(directory.resolve("ordering.db")).put("wire", config.toString()));
            fixture.connect("source", "source");
            fixture.connect("retirement", "retirement");
            var views = reverse ? List.of("scoreboard", "first-reported", "match-market")
                    : List.of("match-market", "scoreboard", "first-reported");
            for (String client : List.of("z", "a")) {
                fixture.connect(client, "client");
                for (String view : views) {
                    fixture.call(turn("subscribe", 0).put("session", client).put("wire",
                            JSON.createObjectNode().put("action", "subscribe").put("viewId", view)
                                    .put("entityId", "match-1").toString()));
                    fixture.advance(0);
                }
            }
            var publication = fixture.publish(fact(2, 2, 1, "create", "{\"points\":1}"));
            assertThat(states(publication).stream().map(s -> s.path("viewId").asString())).containsExactlyElementsOf(views);
            for (var target : receipt(publication, "receipt").path("targets")) {
                var names = target.path("fields").valueStream().map(f -> f.path("field").asString()).toList();
                assertThat(names).containsExactlyElementsOf(target.path("viewId").asString().equals("scoreboard")
                        ? List.of("homeScore") : List.of("homeGoals", "homeScore"));
            }
            var delivered = fixture.advance(0).stream().filter(e -> e.path("kind").asString().equals("frame")).toList();
            assertThat(delivered.stream().map(e -> e.path("session").asString() + ":"
                    + JSON.readTree(e.path("wire").asString()).path("viewId").asString())).containsExactly(
                            "z:" + views.get(0), "a:" + views.get(0), "z:" + views.get(1), "a:" + views.get(1),
                            "z:" + views.get(2), "a:" + views.get(2));
            fixture.retire("match-market", 3, reverse ? new String[]{"homeScore", "homeGoals"} : new String[]{"homeGoals", "homeScore"});
            var retired = fixture.advance(0).stream().filter(e -> e.path("kind").asString().equals("frame")).toList();
            assertThat(retired.stream().map(e -> e.path("session").asString())).containsExactly("z", "a");
            for (var effect : retired) {
                var frame = JSON.readTree(effect.path("wire").asString());
                assertThat(frame.path("version").longValue()).isEqualTo(2);
                assertThat(frame.at("/data/homeGoals").size()).isZero();
                assertThat(frame.at("/status/fields/homeScore/facts/minimumBirthSequence").longValue()).isEqualTo(3);
            }
        }
    }

    @Test void sportsProgressAndTheRealMarketDeadlineRemainProductionOwned() throws Exception {
        try (var fixture = new SportsTestSupport()) {
            fixture.start(directory.resolve("progress.db"));
            fixture.connect("source", "source");
            fixture.connect("progress", "progress");
            fixture.publish("""
                    {"sourceId":"bookmaker","epoch":"run","sourceEntityId":"match-1",
                     "publicationSequence":1,"type":"market.state","payload":{"price":2}}
                    """);
            var response = fixture.call(turn("progress", 0).put("session", "progress").put("wire", """
                    {"sourceId":"bookmaker","epoch":"run","sourceEntityId":"match-1","throughSequence":3}
                    """));
            assertThat(receipt(response, "control-receipt")).isEqualTo(JSON.readTree("""
                    {"kind":"watermark","status":"committed","reason":"sqlite",
                     "stream":{"sourceId":"bookmaker","epoch":"run","sourceEntityId":"match-1"},
                     "throughSequence":3,"version":2,"changedViews":["match-market"]}
                    """));
            fixture.advance(14999);
            assertThat(fixture.snapshot("match-market").at("/status/fields/market/freshness").asString()).isEqualTo("fresh");
            fixture.advance(15000);
            var expired = fixture.snapshot("match-market");
            assertThat(expired.at("/status/fields/market/freshness").asString()).isEqualTo("stale");
            assertThat(expired.path("version").longValue()).isEqualTo(3);
            assertThat(expired.at("/status/inputs/bookmaker/missingRanges")).isEqualTo(JSON.readTree(
                    "[{\"from\":2,\"through\":3,\"status\":\"confirmed\"}]"));
        }
    }

    @Test void failedRetirementStorageCannotAcknowledgeAHostTurn() throws Exception {
        var fixture = new SportsTestSupport();
        fixture.start(directory.resolve("failed.db"));
        fixture.connect("retirement", "retirement");
        var runtime = field(fixture.host, "runtime");
        var connection = (java.sql.Connection) field(field(runtime, "storage"), "connection");
        try (var statement = connection.createStatement()) {
            statement.execute("CREATE TRIGGER refuse_stream BEFORE INSERT ON streams "
                    + "BEGIN SELECT RAISE(ABORT, 'injected retirement failure'); END");
        }
        connection.commit();
        try {
            assertThatThrownBy(() -> fixture.retire("scoreboard", 2, "homeScore"))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("SQLite storage requires recovery");
        } finally {
            ((AutoCloseable) runtime).close();
        }
    }

    private static Object field(Object owner, String name) throws Exception {
        var field = owner.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(owner);
    }
}
