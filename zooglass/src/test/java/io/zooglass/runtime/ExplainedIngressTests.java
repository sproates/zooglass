package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

class ExplainedIngressTests {
    private final JsonMapper json = new JsonMapper();
    private final TextMessage message =
            new TextMessage(IdentityFixtures.envelope(1, "{\"value\":1}"));

    @Test
    void explainedIngressSendsExactlyTheOrdinaryReceiptAndKeepsRetryDecisionsSeparate()
            throws Exception {
        try (var ordinary = new ViewCoordinator(IdentityFixtures.configuration(2, 10, 3));
                var explained = new ViewCoordinator(IdentityFixtures.configuration(2, 10, 3))) {
            var ordinaryIngress = new EventIngress(ordinary, json);
            var explainedIngress = new EventIngress(explained, json);
            var ordinaryReceipts = new ArrayList<String>();
            var explainedReceipts = new ArrayList<String>();
            var ordinarySession = collecting(ordinaryReceipts);
            var explainedSession = collecting(explainedReceipts);

            ordinaryIngress.handleTextMessage(ordinarySession, message);
            var initial = explainedIngress.handleExplainedMessage(explainedSession, message);
            ordinaryIngress.handleTextMessage(ordinarySession, message);
            var retry = explainedIngress.handleExplainedMessage(explainedSession, message);

            assertThat(explainedReceipts).isEqualTo(ordinaryReceipts);
            assertThat(explainedReceipts)
                    .allSatisfy(
                            receipt ->
                                    assertThat(receipt)
                                            .doesNotContain(
                                                    "publication-decision",
                                                    "installed",
                                                    "retainedChanged"));
            assertThat(initial.decision().installed()).isTrue();
            assertThat(initial.decision().targets()).hasSize(3);
            assertThat(retry.outcome().status()).isEqualTo("duplicate");
            assertThat(retry.decision().installed()).isFalse();
            assertThat(retry.decision().targets()).isEmpty();
            assertThat(retry.outcome().targets()).isEqualTo(initial.outcome().targets());
            for (String view : List.of("arrival", "latest", "history"))
                assertThat(explained.snapshot(view, "car"))
                        .isEqualTo(ordinary.snapshot(view, "car"));
        }
    }

    @Test
    void malformedAndProcessingFailureHaveExplicitOutcomesWithoutInventedDecisions()
            throws Exception {
        var runtime = mock(ViewCoordinator.class);
        when(runtime.applyExplained(any())).thenThrow(new IllegalStateException("private payload"));
        var ingress = new EventIngress(runtime, json);
        var receipts = new ArrayList<String>();
        var session = collecting(receipts);

        var malformed = ingress.handleExplainedMessage(session, new TextMessage("{}"));
        verifyNoInteractions(runtime);
        var failed = ingress.handleExplainedMessage(session, message);

        assertThat(malformed.outcome()).isEqualTo(PublicationOutcome.malformed());
        assertThat(malformed.decision()).isNull();
        assertThat(failed.outcome().status()).isEqualTo("failed");
        assertThat(failed.outcome().reason()).isEqualTo("processingFailure");
        assertThat(failed.decision()).isNull();
        assertThat(receipts)
                .hasSize(2)
                .allSatisfy(receipt -> assertThat(receipt).doesNotContain("private payload"));
    }

    @Test
    void unavailableDecisionAfterAnInstalledApplicationDoesNotClaimRollback() throws Exception {
        try (var runtime = spy(new ViewCoordinator(IdentityFixtures.configuration(2, 10, 3)))) {
            doAnswer(
                            call -> {
                                call.callRealMethod();
                                throw new IllegalStateException("failure after installation");
                            })
                    .when(runtime)
                    .applyExplained(any());
            var ingress = new EventIngress(runtime, json);
            var result = ingress.handleExplainedMessage(collecting(new ArrayList<>()), message);

            assertThat(result.outcome().reason()).isEqualTo("processingFailure");
            assertThat(result.decision()).isNull();
            assertThat(runtime.snapshot("arrival", "car").orElseThrow().version()).isEqualTo(1);
            assertThat(runtime.apply(PublicationJson.parse(message.getPayload())).status())
                    .isEqualTo("duplicate");
        }
    }

    @Test
    void transportFailureIsStillThrownAndRetryDoesNotReapply() throws Exception {
        try (var runtime = new ViewCoordinator(IdentityFixtures.configuration(2, 10, 3))) {
            var ingress = new EventIngress(runtime, json);
            var lost = mock(WebSocketSession.class);
            doThrow(new IOException("disconnected")).when(lost).sendMessage(any());

            assertThatThrownBy(() -> ingress.handleExplainedMessage(lost, message))
                    .isInstanceOf(IOException.class);
            var before = runtime.snapshot("arrival", "car");
            var retry = ingress.handleExplainedMessage(collecting(new ArrayList<>()), message);

            assertThat(retry.outcome().status()).isEqualTo("duplicate");
            assertThat(retry.decision().targets()).isEmpty();
            assertThat(runtime.snapshot("arrival", "car")).isEqualTo(before);
        }
    }

    private WebSocketSession collecting(List<String> messages) throws IOException {
        var session = mock(WebSocketSession.class);
        doAnswer(
                        call -> {
                            messages.add(((TextMessage) call.getArgument(0)).getPayload());
                            return null;
                        })
                .when(session)
                .sendMessage(any());
        return session;
    }
}
