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

class ProgressConfigurationTests {

    @TempDir Path directory;

    private static final JsonMapper JSON = new JsonMapper();

    @Test
    void malformedProgressSettingsAndUnsupportedLaterPoliciesFailStartup() throws Exception {
        for (String settings :
                List.of(
                        "{}",
                        "{\"mode\":\"other\"}",
                        "{\"mode\":\"untracked\",\"startSequence\":1}",
                        "{\"mode\":\"contiguousSequence\"}",
                        "{\"mode\":\"contiguousSequence\",\"startSequence\":0,\"maxReceivedRanges\":1,\"maxMissingRanges\":1}",
                        "{\"mode\":\"contiguousSequence\",\"startSequence\":1.5,\"maxReceivedRanges\":1,\"maxMissingRanges\":1}",
                        "{\"mode\":\"contiguousSequence\",\"startSequence\":1,\"maxReceivedRanges\":0,\"maxMissingRanges\":1}",
                        "{\"mode\":\"contiguousSequence\",\"startSequence\":1,\"maxReceivedRanges\":1,\"maxMissingRanges\":9007199254740992}",
                        "{\"mode\":\"contiguousSequence\",\"startSequence\":true,\"maxReceivedRanges\":1,\"maxMissingRanges\":1}",
                        "{\"mode\":\"contiguousSequence\",\"startSequence\":1,\"maxReceivedRanges\":\"1\",\"maxMissingRanges\":1}",
                        "{\"mode\":\"untracked\",\"extra\":1}")) {
            var config = base();
            ((ObjectNode) config.at("/sources/0")).set("progress", JSON.readTree(settings));
            assertThatThrownBy(() -> load(config))
                    .as(settings)
                    .isInstanceOf(RuntimeException.class);
        }
        for (String late :
                List.of("{}", "{\"mode\":\"other\"}", "{\"mode\":\"acceptLate\",\"timeout\":1}")) {
            var config = base();
            ((ObjectNode) config.at("/views/0/fields/accept")).set("late", JSON.readTree(late));
            assertThatThrownBy(() -> load(config)).isInstanceOf(RuntimeException.class);
        }
        for (String unsupported : List.of("freshness", "publication")) {
            var config = base();
            var target =
                    (ObjectNode)
                            config.at(
                                    unsupported.equals("freshness")
                                            ? "/views/0/fields/accept"
                                            : "/views/0");
            target.set(unsupported, JSON.readTree("{}"));
            assertThatThrownBy(() -> load(config)).isInstanceOf(RuntimeException.class);
        }
    }

    @Test
    void rejectingLateRequiresContiguousInputAndDefaultFormsNormalise() throws Exception {
        var config = base();
        ((ObjectNode) config.at("/sources/0")).remove("progress");
        assertThatThrownBy(() -> load(config)).isInstanceOf(IllegalArgumentException.class);
        var legacy = (ObjectNode) JSON.valueToTree(IdentityFixtures.configuration(10, 10, 10));
        var explicit = load(legacy);
        for (var source : legacy.withArray("sources")) {
            ((ObjectNode) source).remove("progress");
        }
        for (var view : legacy.withArray("views")) {
            ((ObjectNode) view.at("/fields/position")).remove("late");
        }
        assertThat(load(legacy)).isEqualTo(explicit);
    }

    @Test
    void watermarkParserRejectsCoercionDuplicatesAndDomainPayloads() {
        String valid =
                "{\"sourceId\":\"fleet\",\"epoch\":\"v1\",\"sourceEntityId\":\"car\",\"throughSequence\":42}";
        assertThat(ProgressControl.parse(valid)).isEqualTo(ProgressTests.watermark(42));
        for (String invalid :
                List.of(
                        "null",
                        "[]",
                        valid + "{}",
                        valid.replace("42", "42.0"),
                        valid.replace("42", "\"42\""),
                        valid.replace("42", "0"),
                        valid.replace("42", "9007199254740992"),
                        valid.replace("\"car\"", "9"),
                        valid.replace("\"car\"", "\" \""),
                        valid.replace("42}", "42,\"throughSequence\":43}"),
                        valid.replace("42}", "42,\"payload\":{}}"))) {
            assertThatThrownBy(() -> ProgressControl.parse(invalid))
                    .as(invalid)
                    .isInstanceOf(RuntimeException.class);
        }
    }

    private ObjectNode base() {
        return (ObjectNode) JSON.valueToTree(ProgressTests.configuration("memory"));
    }

    private RuntimeConfiguration load(ObjectNode config) throws Exception {
        Path file = directory.resolve("config.json");
        Files.writeString(file, config.toString());
        return RuntimeConfiguration.load(new DefaultResourceLoader(), file.toUri().toString());
    }
}
