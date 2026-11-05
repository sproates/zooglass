package io.zooglass.v2;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;

class RequiredPublicationCrashTests {

    @TempDir Path directory;

    @ParameterizedTest
    @EnumSource(
            value = CrashBoundaryDriver.Boundary.class,
            names = {"BEFORE_COMMIT", "AFTER_COMMIT"})
    @Timeout(120)
    void releaseAndReceiptSurviveOrRollBackTogether(CrashBoundaryDriver.Boundary boundary)
            throws Exception {
        var config = RequiredContributionTests.configuration("sqlite");
        Files.writeString(
                directory.resolve("views.json"), new JsonMapper().writeValueAsString(config));
        String envelope =
                """
                {"sourceId":"%s","epoch":"v1","sourceEntityId":"A","publicationSequence":1,"type":"updated","payload":{}}
                """;
        try (var http = HttpClient.newHttpClient();
                var service = new CrashServiceProcess(directory, boundary);
                var source = new PublicationTestClient(http, service.port())) {
            assertThat(source.send(envelope.formatted("orders")).path("status").asText())
                    .isEqualTo("committed");
            service.arm();
            source.publish(envelope.formatted("payments"));
            service.awaitBoundary(boundary);
            service.kill();
            source.assertDisconnectedWithoutReply();
        }
        boolean committed = boundary == CrashBoundaryDriver.Boundary.AFTER_COMMIT;
        try (var runtime =
                new ViewCoordinator(config, directory.resolve("state.sqlite").toString())) {
            var beforeRetry = runtime.snapshot("dispatch", "A").orElseThrow();
            if (committed) {
                assertThat(beforeRetry.data()).containsOnlyKeys("order", "payment");
            } else {
                assertThat(beforeRetry.data()).isEmpty();
            }
            var retry = runtime.apply(RequiredContributionTests.report("payments", "A", 1));
            assertThat(retry.status()).isEqualTo(committed ? "duplicate" : "committed");
            assertThat(retry.targets().getLast().changedFields())
                    .containsExactly("order", "payment");
        }
    }
}
