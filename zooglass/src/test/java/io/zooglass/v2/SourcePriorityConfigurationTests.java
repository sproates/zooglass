package io.zooglass.v2;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.zooglass.strategy.contribution.ContributionStrategySelection;
import io.zooglass.strategy.contribution.IndependentFields;
import io.zooglass.strategy.contribution.SelectedContribution;
import io.zooglass.strategy.contribution.SourcePriority;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.DefaultResourceLoader;

import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

class SourcePriorityConfigurationTests {

    @TempDir Path directory;

    private static final JsonMapper JSON = new JsonMapper();

    @Test
    void concreteSelectorsHandleAbsentCandidatesAndNeverCompareSequences() {
        var independent =
                ContributionStrategySelection.select("independentFields", null, Set.of("primary"));
        var priority =
                ContributionStrategySelection.select(
                        "sourcePriority",
                        List.of("primary", "backup"),
                        Set.of("primary", "backup"));
        assertThat(independent).isInstanceOf(IndependentFields.class);
        assertThat(priority).isInstanceOf(SourcePriority.class);
        assertThat(independent.select(Map.of())).isNull();
        assertThat(priority.select(Map.of())).isNull();
        var backup =
                new SelectedContribution(
                        JSON.readTree("{\"publicationSequence\":900}"),
                        new Provenance("backup", "v1", "tracking"));
        var primary =
                new SelectedContribution(
                        JSON.readTree("{\"publicationSequence\":2}"),
                        new Provenance("primary", "v1", "shipment"));
        assertThat(priority.select(Map.of("backup", backup))).isSameAs(backup);
        assertThat(priority.select(Map.of("primary", primary, "backup", backup))).isSameAs(primary);
        assertThat(independent.select(Map.of("primary", primary))).isSameAs(primary);
    }

    @Test
    void invalidPriorityGrammarFailsDuringConfigurationLoading() throws Exception {
        for (String conflict :
                List.of(
                        "null",
                        "{}",
                        "{\"mode\":\"independentFields\"}",
                        "{\"mode\":\"sourcePriority\"}",
                        "{\"mode\":\"sourcePriority\",\"sources\":[]}",
                        "{\"mode\":\"sourcePriority\",\"sources\":[\"primary\"]}",
                        "{\"mode\":\"sourcePriority\",\"sources\":[\"primary\",\"primary\"]}",
                        "{\"mode\":\"sourcePriority\",\"sources\":[\"primary\",\"unknown\"]}",
                        "{\"mode\":\"sourcePriority\",\"sources\":[\"primary\",null]}",
                        "{\"mode\":\"sourcePriority\",\"sources\":[\"primary\",9]}",
                        "{\"mode\":\"other\",\"sources\":[\"primary\",\"backup\"]}")) {
            var config = base();
            field(config).set("conflict", JSON.readTree(conflict));
            assertThatThrownBy(() -> load(config))
                    .as(conflict)
                    .isInstanceOf(RuntimeException.class);
        }
        for (String mode : List.of("arrival", "historyBySequence")) {
            var config = base();
            field(config).put("mode", mode);
            assertThatThrownBy(() -> load(config)).isInstanceOf(RuntimeException.class);
        }
        for (String inputs :
                List.of(
                        "[]",
                        "[null]",
                        "[{\"sourceId\":\"primary\",\"type\":\"updated\"},{\"sourceId\":\"primary\",\"type\":\"other\"}]",
                        "[{\"sourceId\":\"primary\",\"type\":\"\"},{\"sourceId\":\"backup\",\"type\":\"updated\"}]")) {
            var config = base();
            field(config).set("inputs", JSON.readTree(inputs));
            assertThatThrownBy(() -> load(config)).as(inputs).isInstanceOf(RuntimeException.class);
        }
    }

    @Test
    void inputOrderNormalisesWhilePriorityOrderRemainsSignificant() throws Exception {
        var config = base();
        var original = load(config);
        var inputs = field(config).withArray("inputs");
        var first = inputs.remove(0);
        inputs.add(first);
        assertThat(load(config)).isEqualTo(original);
        field(config)
                .set(
                        "conflict",
                        JSON.readTree(
                                "{\"mode\":\"sourcePriority\",\"sources\":[\"backup\",\"primary\"]}"));
        assertThat(load(config)).isNotEqualTo(original);
    }

    private ObjectNode base() {
        return (ObjectNode) JSON.valueToTree(SourcePriorityTests.configuration("memory"));
    }

    private ObjectNode field(ObjectNode config) {
        return (ObjectNode) config.at("/views/0/fields/status");
    }

    private V2Configuration load(ObjectNode config) throws Exception {
        Path path = directory.resolve("config.json");
        Files.writeString(path, config.toString());
        return V2Configuration.load(new DefaultResourceLoader(), path.toUri().toString());
    }
}
