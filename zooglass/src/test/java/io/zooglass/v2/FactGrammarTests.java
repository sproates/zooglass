package io.zooglass.v2;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.core.io.DefaultResourceLoader;

import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;

class FactGrammarTests {

    @TempDir Path directory;

    private static final JsonMapper JSON = new JsonMapper();

    @ParameterizedTest
    @ValueSource(
            strings = {
                "null",
                "{}",
                "{\"birthSequence\":1,\"revision\":1,\"operation\":\"revise\"}",
                "{\"birthSequence\":2,\"revision\":1,\"operation\":\"create\"}",
                "{\"birthSequence\":1.0,\"revision\":1,\"operation\":\"create\"}",
                "{\"birthSequence\":1,\"revision\":0,\"operation\":\"create\"}",
                "{\"birthSequence\":1,\"revision\":1,\"operation\":\"other\"}",
                "{\"birthSequence\":1,\"revision\":1,\"operation\":\"create\",\"extra\":true}",
            })
    void malformedFactMetadataNeverReachesTheRuntime(String fact) {
        String envelope =
                """
                {"sourceId":"match","epoch":"v1","sourceEntityId":"game","publicationSequence":1,
                 "type":"goal","payload":{},"fact":%s}
                """
                        .formatted(fact);
        assertThatThrownBy(() -> PublicationJson.parse(envelope))
                .isInstanceOf(RuntimeException.class);
    }

    @Test
    void retractRejectsNonemptyPayloadAndUnsafeNumbers() {
        assertThatThrownBy(() -> FactFixtures.event(2, 1, 2, "retract", "{\"points\":1}"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(
                        () ->
                                FactFixtures.event(
                                        2, 1, PublicationJson.MAX_SEQUENCE + 1, "revise", "{}"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "null",
                "{}",
                "{\"revision\":\"unknown\",\"maxRetainedFacts\":10,\"minimumBirthSequence\":1}",
                "{\"revision\":\"firstFact\",\"maxRetainedFacts\":0,\"minimumBirthSequence\":1}",
                "{\"revision\":\"firstFact\",\"maxRetainedFacts\":1.5,\"minimumBirthSequence\":1}",
            })
    void configurationRejectsIncompleteOrInvalidFactSettings(String settings) throws Exception {
        var document = JSON.valueToTree(FactFixtures.configuration("memory", 10, false));
        ((tools.jackson.databind.node.ObjectNode) document.at("/views/0/fields/goals"))
                .set("facts", JSON.readTree(settings));
        Path file = directory.resolve("bad.json");
        Files.writeString(file, JSON.writeValueAsString(document));
        assertThatThrownBy(
                        () ->
                                V2Configuration.load(
                                        new DefaultResourceLoader(), file.toUri().toString()))
                .isInstanceOf(RuntimeException.class);
    }

    @Test
    void sumWithoutPropertyAndFactSettingsOnOrdinaryModesAreRejected() throws Exception {
        for (String mode : new String[] {"sumActiveFacts", "latestBySequence"}) {
            var document = JSON.valueToTree(FactFixtures.configuration("memory", 10, false));
            ((tools.jackson.databind.node.ObjectNode) document.at("/views/0/fields/goals"))
                    .put("mode", mode);
            Path file = directory.resolve("bad.json");
            Files.writeString(file, JSON.writeValueAsString(document));
            assertThatThrownBy(
                            () ->
                                    V2Configuration.load(
                                            new DefaultResourceLoader(), file.toUri().toString()))
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"null", "1", "true", "\"\"", "\"  \""})
    void sumPropertyMustBeANonblankJsonString(String property) throws Exception {
        var document = JSON.valueToTree(FactFixtures.scores("memory"));
        var score = (tools.jackson.databind.node.ObjectNode) document.at("/views/0/fields/score");
        score.set("property", JSON.readTree(property));
        Path file = directory.resolve("bad-property.json");
        Files.writeString(file, JSON.writeValueAsString(document));
        assertThatThrownBy(
                        () ->
                                V2Configuration.load(
                                        new DefaultResourceLoader(), file.toUri().toString()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"[]", "[\"goals\",\"goals\"]", "[null]", "[1]", "\"goals\""})
    void retirementRequiresUniqueNamedFields(String fields) {
        assertThatThrownBy(
                        () ->
                                FactRetirement.parse(
                                        """
                                        {"viewId":"v","entityId":"e","fields":%s,"minimumBirthSequence":2}
                                        """
                                                .formatted(fields)))
                .isInstanceOf(RuntimeException.class);
    }
}
