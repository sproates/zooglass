package io.zooglass.runtime;

import static io.zooglass.runtime.FactFixtures.configuration;
import static io.zooglass.runtime.FactFixtures.event;
import static io.zooglass.runtime.FactFixtures.retire;
import static io.zooglass.runtime.FactFixtures.snapshot;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.ArrayList;

class FactIngressTests {

    private static final JsonMapper JSON = new JsonMapper();

    @Test
    void failedStorageIsNotMisreportedAsMalformedControl() throws Exception {
        var runtime = mock(ViewCoordinator.class);
        when(runtime.retire(any())).thenThrow(new IllegalStateException("private payload"));
        var replies = new ArrayList<String>();
        var socket = mock(WebSocketSession.class);
        doAnswer(
                        invocation -> {
                            replies.add(((TextMessage) invocation.getArgument(0)).getPayload());
                            return null;
                        })
                .when(socket)
                .sendMessage(any());
        new FactRetirementIngress(runtime, JSON)
                .handleTextMessage(
                        socket, new TextMessage(JSON.writeValueAsString(retire("corrected", 2))));
        assertThat(JSON.readTree(replies.getFirst()).path("reason").asText())
                .isEqualTo("processingFailure");
        assertThat(replies.getFirst()).doesNotContain("private payload");
    }

    @Test
    void lostRetirementAcknowledgementDoesNotRepeatTheChange() throws Exception {
        try (var runtime = new ViewCoordinator(configuration("memory", 10, false))) {
            runtime.apply(event(1, 1, 1, "create", "{}"));
            var socket = mock(WebSocketSession.class);
            doThrow(new IOException("closed")).when(socket).sendMessage(any());
            var ingress = new FactRetirementIngress(runtime, JSON);
            var control = retire("corrected", 2);
            assertThatThrownBy(
                            () ->
                                    ingress.handleTextMessage(
                                            socket,
                                            new TextMessage(JSON.writeValueAsString(control))))
                    .isInstanceOf(IOException.class);
            var before = snapshot(runtime, "corrected");
            assertThat(runtime.retire(control).status()).isEqualTo("unchanged");
            assertThat(snapshot(runtime, "corrected")).isEqualTo(before);
        }
    }
}
