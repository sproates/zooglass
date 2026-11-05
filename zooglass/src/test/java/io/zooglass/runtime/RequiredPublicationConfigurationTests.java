package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.DefaultResourceLoader;

import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

class RequiredPublicationConfigurationTests {

    @TempDir Path directory;

    private final JsonMapper json = new JsonMapper();

    @Test
    void omissionEqualsPartialAndRequiredOrderDoesNotChangeDefinition() throws Exception {
        var partial = load(null);
        assertThat(load("{\"mode\":\"publishPartial\"}")).isEqualTo(partial);
        var settings =
                """
                {"mode":"requireContributions","fields":["payment","order"],"maxPendingEntities":2}
                """;
        assertThat(load(settings).publication().fields()).containsExactly("order", "payment");
        assertThat(load(settings.replace("\"payment\",\"order\"", "\"order\",\"payment\"")))
                .isEqualTo(load(settings));
    }

    @Test
    void explicitNullDoesNotSelectPartialPublication() {
        assertThatThrownBy(() -> load("null")).isInstanceOf(RuntimeException.class);
    }

    @Test
    void defaultPolicyKeepsThePreviousStoredViewFormat() throws Exception {
        var config = RequiredContributionTests.configuration("sqlite");
        var database = directory.resolve("storage.db");
        try (var runtime = new ViewCoordinator(config, database.toString())) {
            runtime.apply(RequiredContributionTests.report("orders", "A", 1));
        }
        try (var connection = java.sql.DriverManager.getConnection("jdbc:sqlite:" + database);
                var query = connection.createStatement();
                var row = query.executeQuery("SELECT configuration FROM runtime WHERE id=1")) {
            assertThat(row.next()).isTrue();
            var views = json.readTree(row.getString(1)).get("views");
            assertThat(views.get(0).has("publication")).isFalse();
            assertThat(views.get(1).at("/publication/mode").asText())
                    .isEqualTo("requireContributions");
        }
    }

    @Test
    void rejectsUnknownFieldsDuplicatesAndMalformedLimits() {
        var valid =
                """
                {"mode":"requireContributions","fields":["order"],"maxPendingEntities":2}
                """;
        for (String invalid :
                List.of(
                        valid.replace("order", "missing"),
                        valid.replace("[\"order\"]", "[]"),
                        valid.replace("\"order\"", "\"order\",\"order\""),
                        valid.replace(":2", ":0"),
                        valid.replace(":2", ":9007199254740992"),
                        valid.replace(":2", ":2.5"),
                        valid.replace(":2", ":\"2\""),
                        valid.replace(",\"maxPendingEntities\":2", ""),
                        valid.replace("requireContributions", "publishPartial"),
                        valid.replace(":2", ":2,\"extra\":1"))) {
            assertThatThrownBy(() -> load(invalid))
                    .as(invalid)
                    .isInstanceOf(RuntimeException.class);
        }
    }

    private RuntimeConfiguration.View load(String settings) throws Exception {
        var configuration =
                (ObjectNode) json.valueToTree(RequiredContributionTests.configuration("memory"));
        var view = (ObjectNode) configuration.at("/views/1");
        if (settings == null) {
            view.remove("publication");
        } else {
            view.set("publication", json.readTree(settings));
        }
        var file = directory.resolve("views.json");
        Files.writeString(file, configuration.toString());
        return RuntimeConfiguration.load(new DefaultResourceLoader(), file.toUri().toString())
                .views()
                .getLast();
    }
}
