package io.zooglass.v2;

import io.zooglass.strategy.identity.EnvelopeEntity;
import io.zooglass.strategy.identity.EntityStrategySelection;
import io.zooglass.strategy.identity.LookupEntity;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.DefaultResourceLoader;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class EntityConfigurationTests {
    @TempDir
    Path directory;
    private static final JsonMapper JSON = new JsonMapper();

    @Test
    void selectsConcreteStrategiesAndPreservesExactKeys() {
        assertThat(EntityStrategySelection.select("envelopeEntity", null)).isInstanceOf(EnvelopeEntity.class);
        var lookup = EntityStrategySelection.select("lookupEntity", Map.of(" Payment ", " Order "));
        assertThat(lookup).isInstanceOf(LookupEntity.class);
        assertThat(lookup.resolve(" Payment ").entityId()).isEqualTo(" Order ");
        assertThat(lookup.resolve("Payment").resolved()).isFalse();
        assertThat(lookup.resolve(" payment ").resolved()).isFalse();
    }

    @Test
    void invalidResolverSettingsAndReferencesFailStartup() throws Exception {
        for (String entity : List.of(
                "null", "{}", "{\"mode\":\"plugin\"}",
                "{\"mode\":\"envelopeEntity\",\"keys\":{}}",
                "{\"mode\":\"lookupEntity\"}",
                "{\"mode\":\"lookupEntity\",\"keys\":{\"a\":\"same\",\"b\":\"same\"}}",
                "{\"mode\":\"lookupEntity\",\"keys\":{\" \":\"order\"}}",
                "{\"mode\":\"lookupEntity\",\"keys\":{\"a\":\" \"}}",
                "{\"mode\":\"lookupEntity\",\"keys\":{\"a\":null}}",
                "{\"mode\":\"lookupEntity\",\"keys\":{\"a\":9}}",
                "{\"mode\":\"lookupEntity\",\"keys\":{},\"fallback\":true}")) {
            var config = base();
            ((ObjectNode) config.at("/views/0/entities")).set("payments", JSON.readTree(entity));
            assertThatThrownBy(() -> load(config), entity).isInstanceOf(RuntimeException.class);
        }
        var config = base();
        ((ObjectNode) config.at("/views/0/entities")).set("unused", JSON.readTree("{\"mode\":\"envelopeEntity\"}"));
        assertThatThrownBy(() -> load(config)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void fieldGrammarRejectsAmbiguityUnsupportedSelectionAndUnknownProperties() throws Exception {
        String shorthand = "\"sourceId\":\"payments\",\"type\":\"updated\",\"mode\":\"arrival\"";
        for (String field : List.of(
                "{" + shorthand + ",\"inputs\":[]}",
                "{\"inputs\":[],\"mode\":\"arrival\"}",
                "{\"inputs\":[null],\"mode\":\"arrival\"}",
                "{\"inputs\":[\"payments.updated\"],\"mode\":\"arrival\"}",
                "{\"inputs\":[{\"sourceId\":\"payments\",\"type\":\"updated\",\"extra\":1}],\"mode\":\"arrival\"}",
                "{\"inputs\":[{\"sourceId\":\"payments\",\"type\":\"updated\"},{\"sourceId\":\"orders\",\"type\":\"updated\"}],\"mode\":\"arrival\"}",
                "{" + shorthand + ",\"conflict\":{\"mode\":\"sourcePriority\"}}",
                "{" + shorthand + ",\"conflict\":{\"mode\":\"independentFields\",\"sources\":[]}}",
                "{" + shorthand + ",\"freshness\":{}}",
                "{" + shorthand + ",\"update\":{}}",
                "{" + shorthand + ",\"name\":\"payment\"}")) {
            var config = base();
            ((ObjectNode) config.at("/views/0/fields")).set("payment", JSON.readTree(field));
            assertThatThrownBy(() -> load(config)).as(field).isInstanceOf(RuntimeException.class);
        }
    }

    @Test
    void equivalentFormsNormaliseAndRetainedDefinitionsOwnTheirMappings() throws Exception {
        var expanded = load(base());
        var shorthand = base();
        ((ObjectNode) shorthand.at("/views/0/fields")).set("payment", JSON.readTree("""
                {"sourceId":"payments","type":"updated","mode":"latestBySequence"}
                """));
        ((ObjectNode) shorthand.at("/views/0/entities")).set("orders", JSON.readTree("{\"mode\":\"envelopeEntity\"}"));
        var equivalent = load(shorthand);
        assertThat(equivalent).isEqualTo(expanded);
        assertThatThrownBy(() -> expanded.views().getFirst().entities().get("payments").keys().clear())
                .isInstanceOf(UnsupportedOperationException.class);
    }

    private ObjectNode base() throws Exception {
        return (ObjectNode) JSON.readTree(Files.readString(Path.of("src/test/resources/mapped-views-test.json")));
    }

    private V2Configuration load(ObjectNode config) throws Exception {
        Path path = directory.resolve("config.json");
        Files.writeString(path, config.toString());
        return V2Configuration.load(new DefaultResourceLoader(), path.toUri().toString());
    }
}
