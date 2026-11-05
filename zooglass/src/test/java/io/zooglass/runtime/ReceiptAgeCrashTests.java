package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;

class ReceiptAgeCrashTests {

    @TempDir Path directory;

    @ParameterizedTest
    @EnumSource(
            value = CrashBoundaryDriver.Boundary.class,
            names = {"BEFORE_COMMIT", "AFTER_COMMIT"})
    @Timeout(120)
    void silentSourceExpiresWithoutReadsAndRestartFinishesOnlyUncommittedExpiry(
            CrashBoundaryDriver.Boundary boundary) throws Exception {
        var config = ReceiptAgeTests.config("sqlite", 100);
        Files.writeString(
                directory.resolve("views.json"), new JsonMapper().writeValueAsString(config));
        var db = directory.resolve("state.sqlite");
        try (var http = HttpClient.newHttpClient();
                var process = new CrashServiceProcess(directory, boundary);
                var client = new PublicationTestClient(http, process.port())) {
            process.armTimer();
            var result =
                    client.send(
                            """
                            {"sourceId":"fleet","epoch":"v1","sourceEntityId":"car","publicationSequence":1,
                             "type":"position","payload":{}}
                            """);
            assertThat(result.path("status").asText()).isEqualTo("committed");
            process.awaitBoundary(boundary);
            process.kill();
        }
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + db);
                var query = connection.createStatement();
                var row = query.executeQuery("SELECT version FROM runtime WHERE id=1")) {
            assertThat(row.next()).isTrue();
            assertThat(row.getLong(1))
                    .isEqualTo(boundary == CrashBoundaryDriver.Boundary.BEFORE_COMMIT ? 1 : 2);
        }
        try (var service = new ViewCoordinator(config, db.toString())) {
            assertThat(ReceiptAgeTests.position(service).freshness()).isEqualTo("stale");
            assertThat(ReceiptAgeTests.snapshot(service).version()).isEqualTo(2);
            assertThat(service.apply(ProgressTests.event(1)).version()).isEqualTo(1);
        }
    }
}
