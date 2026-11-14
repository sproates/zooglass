package io.zooglass.simulation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

class HostProtocolTests {
    @Test
    void advertisesMemoryLifecycleWithoutClaimingADocumentFormat() {
        assertThat(HostProtocol.V1.handshake("artifact", null))
                .containsEntry("protocol", 1)
                .containsEntry("configurationAdmission", 1)
                .containsEntry("documentFormats", List.of("timeline-simulation/v1"))
                .doesNotContainKeys("memoryLifecycle", "wallClockAdjustments");
        assertThat(HostProtocol.V2.handshake("artifact", null))
                .containsEntry("protocol", 2)
                .containsEntry("memoryLifecycle", 1)
                .containsEntry("wallClockAdjustments", 1)
                .containsEntry("documentFormats", List.of())
                .containsEntry("storage", List.of("memory"))
                .doesNotContainKeys("configurationAdmission", "sqliteLifecycle");
    }

    @Test
    void sqliteCapabilityIncludesTheNativeVersion() {
        String version = HostProtocol.availableSqliteVersion();
        assertThat(version).matches("[0-9]+\\.[0-9]+\\.[0-9]+");
        var handshake = HostProtocol.V2.handshake("artifact", version);

        assertThat(handshake)
                .containsEntry("sqliteLifecycle", 1)
                .containsEntry("storage", List.of("memory", "sqlite"));
        assertThat(handshake.get("environment"))
                .isInstanceOfSatisfying(Map.class, environment ->
                        assertThat(environment.get("sqliteVersion")).isEqualTo(version));
    }

    @Test
    void decodesUtf8CommandTextWithoutChangingItsCharacters() throws IOException {
        var bytes = "{\"op\":\"connect\",\"session\":\"viewer-é-𐀀\"}"
                .getBytes(StandardCharsets.UTF_8);

        var command = HostProtocol.decodeCommand(bytes);

        assertThat(command.path("session").asString()).isEqualTo("viewer-é-𐀀");
    }

    @Test
    void rejectsMalformedUtf8InsideOtherwiseValidCommandJson() {
        String command = "{\"op\":\"connect\",\"session\":\"viewer-\u00c3(\"}";
        // Keep the lead byte without the required UTF-8 continuation byte.
        var bytes = command.getBytes(StandardCharsets.ISO_8859_1);

        assertThatThrownBy(() -> HostProtocol.decodeCommand(bytes))
                .isInstanceOf(IOException.class)
                .hasMessage("Command frame is not valid UTF-8");
    }
}
