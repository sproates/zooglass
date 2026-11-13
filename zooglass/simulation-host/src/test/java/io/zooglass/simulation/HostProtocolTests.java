package io.zooglass.simulation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

class HostProtocolTests {
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
