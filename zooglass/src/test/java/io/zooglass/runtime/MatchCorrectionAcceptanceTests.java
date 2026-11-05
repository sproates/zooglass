package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

class MatchCorrectionAcceptanceTests {
    private static final JsonMapper JSON = new JsonMapper();
    private static final String CREATE = goal(1, 1, "create", "{\"scorer\":\"A\",\"points\":1}");
    private static final String CORRECT = goal(2, 2, "revise", "{\"scorer\":\"B\",\"points\":2}");
    private static final String WITHDRAW = goal(3, 3, "retract", "{}");

    @TempDir Path directory;

    @Test
    @Timeout(90)
    void twoScoreboardsFollowTheirRevisionPoliciesThroughLostAckAndRetirement() throws Exception {
        Files.writeString(
                directory.resolve("views.json"),
                JSON.writeValueAsString(FactFixtures.scores("sqlite")));
        try (var http = HttpClient.newHttpClient()) {
            var createReceipt = playUntilWithdrawalCommits(http);
            verifyRecoveryAndRetention(http, createReceipt);
        }
    }

    private JsonNode playUntilWithdrawalCommits(HttpClient http) throws Exception {
        var boundary = CrashBoundaryDriver.Boundary.AFTER_COMMIT;
        try (var service = new CrashServiceProcess(directory, boundary);
                var source = new PublicationTestClient(http, service.port());
                var corrected = new PublicationTestClient(http, service.port(), "/views/live")) {
            subscribe(corrected, "corrected");
            assertThat(corrected.nextMessage().path("version").longValue()).isZero();
            var created = source.send(CREATE);
            assertThat(created.path("status").asText()).isEqualTo("committed");
            assertGoal(corrected.nextMessage(), "A", 1, 1);

            var revised = source.send(CORRECT);
            assertThat(revised.path("status").asText()).isEqualTo("committed");
            var update = corrected.nextMessage();
            assertThat(update.path("version")).isEqualTo(revised.path("version"));
            assertGoal(update, "B", 2, 2);
            assertGoal(read(http, service.port(), "original"), "A", 1, 1);

            service.arm();
            source.publish(WITHDRAW);
            service.awaitBoundary(boundary);
            service.kill();
            source.assertDisconnectedWithoutReply();
            return created;
        }
    }

    private void verifyRecoveryAndRetention(HttpClient http, JsonNode created) throws Exception {
        try (var service =
                        new CrashServiceProcess(
                                directory, CrashBoundaryDriver.Boundary.AFTER_COMMIT);
                var source = new PublicationTestClient(http, service.port());
                var viewer = new PublicationTestClient(http, service.port(), "/views/live");
                var control = new PublicationTestClient(http, service.port(), "/facts/retire")) {
            subscribe(viewer, "corrected");
            var recovered = viewer.nextMessage();
            assertWithdrawn(recovered);
            assertThat(recovered.at("/status/fields/goals/facts/retainedCount").intValue()).isOne();
            var withdrawalRetry = source.send(WITHDRAW);
            assertThat(withdrawalRetry.path("status").asText()).isEqualTo("duplicate");
            assertThat(withdrawalRetry.path("version")).isEqualTo(recovered.path("version"));

            var originalRetry = source.send(CREATE);
            assertThat(originalRetry.path("status").asText()).isEqualTo("duplicate");
            assertThat(originalRetry.path("version")).isEqualTo(created.path("version"));
            assertThat(originalRetry.path("targets")).isEqualTo(created.path("targets"));
            assertThat(source.send(CORRECT).path("status").asText()).isEqualTo("duplicate");
            var obsolete = source.send(goal(4, 2, "revise", "{\"scorer\":\"B\",\"points\":2}"));
            assertRejectedFields(obsolete, "corrected", "obsoleteRevision");
            assertRejectedFields(obsolete, "original", "factImmutable");
            assertWithdrawn(read(http, service.port(), "corrected"));

            var retirement = new FactRetirement("corrected", "game", List.of("goals", "score"), 2);
            assertThat(control.send(JSON.writeValueAsString(retirement)).path("status").asText())
                    .isEqualTo("committed");
            var outside = source.send(goal(5, 4, "revise", "{\"scorer\":\"C\",\"points\":3}"));
            assertRejectedFields(outside, "corrected", "factOutsideRetention");
            assertThat(source.send(CREATE).path("status").asText()).isEqualTo("duplicate");
            var retired = read(http, service.port(), "corrected");
            assertWithdrawn(retired);
            assertThat(retired.at("/status/fields/goals/facts/retainedCount").intValue()).isZero();
            assertThat(retired.at("/status/fields/goals/facts/minimumBirthSequence").intValue())
                    .isEqualTo(2);
            assertGoal(read(http, service.port(), "original"), "A", 1, 1);
        }
    }

    private static String goal(long publication, long revision, String operation, String payload) {
        return JSON.writeValueAsString(
                FactFixtures.event(publication, 1, revision, operation, payload));
    }

    private static void subscribe(PublicationTestClient viewer, String view) throws Exception {
        var ack =
                viewer.send(
                        """
                        {"action":"subscribe","viewId":"%s","entityId":"game"}
                        """
                                .formatted(view));
        assertThat(ack.path("type").asText()).isEqualTo("subscribed");
    }

    private static JsonNode read(HttpClient http, int port, String view) throws Exception {
        var uri = URI.create("http://127.0.0.1:" + port + "/views/" + view + "/game");
        var response =
                http.send(
                        HttpRequest.newBuilder(uri).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        return JSON.readTree(response.body());
    }

    private static void assertGoal(JsonNode snapshot, String scorer, int revision, int points) {
        var goals = snapshot.at("/data/goals");
        assertThat(goals.isArray()).isTrue();
        assertThat(goals).hasSize(1);
        assertThat(goals.at("/0/birthSequence").intValue()).isOne();
        assertThat(goals.at("/0/revision").intValue()).isEqualTo(revision);
        assertThat(goals.at("/0/payload/scorer").asText()).isEqualTo(scorer);
        assertThat(goals.at("/0/payload/points").intValue()).isEqualTo(points);
        assertThat(snapshot.at("/data/score").decimalValue())
                .isEqualByComparingTo(Integer.toString(points));
    }

    private static void assertWithdrawn(JsonNode snapshot) {
        assertThat(snapshot.at("/data/goals").isArray()).isTrue();
        assertThat(snapshot.at("/data/goals")).isEmpty();
        assertThat(snapshot.at("/data/score").isNumber()).isTrue();
        assertThat(snapshot.at("/data/score").decimalValue()).isZero();
    }

    private static void assertRejectedFields(JsonNode receipt, String view, String reason) {
        var target =
                receipt.path("targets")
                        .valueStream()
                        .filter(t -> t.path("viewId").asText().equals(view))
                        .findFirst()
                        .orElseThrow();
        var fields = target.path("fields");
        assertThat(fields)
                .extracting(field -> field.path("field").asText())
                .containsExactlyInAnyOrder("goals", "score");
        for (var field : fields) {
            assertThat(field.path("status").asText()).isEqualTo("rejected");
            assertThat(field.path("reason").asText()).isEqualTo(reason);
        }
    }
}
