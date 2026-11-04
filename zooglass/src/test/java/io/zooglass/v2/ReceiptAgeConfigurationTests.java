package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.DefaultResourceLoader;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.*;

class ReceiptAgeConfigurationTests {
    @TempDir Path directory;
    private final JsonMapper json = new JsonMapper();

    @Test
    void omittedAndExplicitDefaultsAreEqualAndReceiptAgeBindsItsThreshold() throws Exception {
        assertThat(read(null)).isEqualTo(read("{\"mode\":\"unspecified\"}"));
        assertThat(read("{\"mode\":\"receiptAge\",\"staleAfterMillis\":9007199254740991}")
                .staleAfterMillis()).isEqualTo(9007199254740991L);
    }

    @Test
    void rejectsInvalidModesAndThresholds() {
        for (String value : List.of("0", "-1", "true", "1.5", "\"1\"", "null", "9007199254740992")) {
            String policy = "{\"mode\":\"receiptAge\",\"staleAfterMillis\":" + value + "}";
            assertThatThrownBy(() -> read(policy)).as(policy).isInstanceOf(RuntimeException.class);
        }
        for (String policy : List.of("null", "{}", "{\"mode\":\"unknown\"}", "{\"mode\":\"receiptAge\"}",
                "{\"mode\":\"unspecified\",\"staleAfterMillis\":null}", "{\"mode\":\"unspecified\",\"extra\":true}")) {
            assertThatThrownBy(() -> read(policy)).as(policy).isInstanceOf(RuntimeException.class);
        }
    }

    private V2Configuration.Freshness read(String policy) throws Exception {
        var root = (ObjectNode) json.valueToTree(ReceiptAgeTests.config("memory", 1000));
        var field = (ObjectNode) root.at("/views/0/fields/position");
        if (policy == null) field.remove("freshness");
        else field.set("freshness", json.readTree(policy));
        Path file = directory.resolve("views.json");
        Files.writeString(file, root.toString());
        return V2Configuration.load(new DefaultResourceLoader(), file.toUri().toString())
                .views().getFirst().fields().get("position").freshness();
    }
}
