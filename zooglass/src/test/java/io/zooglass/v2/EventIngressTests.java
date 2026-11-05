package io.zooglass.v2;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

class EventIngressTests {

    private final JsonMapper json = new JsonMapper();
    private final String envelope =
            """
            {"sourceId":"fleet","epoch":"trip-1","sourceEntityId":"car",
             "publicationSequence":1,"type":"position","payload":{"value":1}}
            """;

    @Test
    void processingFailureIsNotMisreportedAsInvalidInput() throws Exception {
        var runtime = mock(ViewCoordinator.class);
        when(runtime.apply(any())).thenThrow(new IllegalStateException("internal payload details"));
        List<String> messages = new ArrayList<>();
        var session = collecting(messages);
        var ingress = new EventIngress(runtime, json);
        ingress.handleTextMessage(session, new TextMessage("{}"));
        verifyNoInteractions(runtime);
        ingress.handleTextMessage(session, new TextMessage(envelope));
        assertThat(json.readTree(messages.get(0)).path("reason").asText())
                .isEqualTo("invalidEnvelope");
        assertThat(json.readTree(messages.get(1)).path("status").asText()).isEqualTo("failed");
        assertThat(json.readTree(messages.get(1)).path("reason").asText())
                .isEqualTo("processingFailure");
        assertThat(messages.get(1)).doesNotContain("internal payload details");
    }

    @Test
    void lostAcknowledgementCanBeRecoveredByRetryWithoutRepeatingEffects() throws Exception {
        var runtime = new ViewCoordinator(IdentityFixtures.configuration(2, 10, 3));
        var ingress = new EventIngress(runtime, json);
        var lost = mock(WebSocketSession.class);
        doThrow(new IOException("disconnected")).when(lost).sendMessage(any());
        assertThatThrownBy(() -> ingress.handleTextMessage(lost, new TextMessage(envelope)))
                .isInstanceOf(IOException.class);
        var before = runtime.snapshot("arrival", "car");
        List<String> messages = new ArrayList<>();
        ingress.handleTextMessage(collecting(messages), new TextMessage(envelope));
        assertThat(json.readTree(messages.getFirst()).path("status").asText())
                .isEqualTo("duplicate");
        assertThat(runtime.snapshot("arrival", "car")).isEqualTo(before);
    }

    private WebSocketSession collecting(List<String> messages) throws IOException {
        var session = mock(WebSocketSession.class);
        doAnswer(
                        invocation -> {
                            messages.add(((TextMessage) invocation.getArgument(0)).getPayload());
                            return null;
                        })
                .when(session)
                .sendMessage(any());
        return session;
    }
}
