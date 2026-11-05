package io.zooglass.delivery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentMatchers;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

class SnapshotOrderingTests {

    private final ObjectMapper objectMapper = JsonMapper.builder().build();

    @Test
    void blockedClientWriteDoesNotBlockEventProcessing() throws Exception {
        RuntimeFixture viewStore =
                new RuntimeFixture(
                        new ViewCases(
                                List.of(
                                        new ViewCases.ViewDefinition(
                                                "match",
                                                Map.of(
                                                        "score",
                                                        List.of(
                                                                new ViewCases.EventMatcher(
                                                                        "match-feed",
                                                                        "score.updated")))))));
        SnapshotBroadcaster broadcaster =
                new SnapshotBroadcaster(objectMapper, viewStore.runtime());
        WebSocketSession client = mock(WebSocketSession.class);
        CountDownLatch sendStarted = new CountDownLatch(1);
        CountDownLatch releaseSend = new CountDownLatch(1);
        when(client.isOpen()).thenReturn(true);
        when(client.getId()).thenReturn("slow-client");
        doAnswer(
                        invocation -> {
                            sendStarted.countDown();
                            releaseSend.await();
                            return null;
                        })
                .when(client)
                .sendMessage(any(TextMessage.class));

        try {
            broadcaster.registerSession(client);
            assertThat(broadcaster.subscribe(client, "match", "match-42")).isTrue();
            assertThat(sendStarted.await(5, TimeUnit.SECONDS)).isTrue();

            CompletableFuture<Void> update =
                    CompletableFuture.runAsync(
                            () ->
                                    viewStore.apply(
                                            "match-feed",
                                            "score.updated",
                                            "unsubscribed-entity",
                                            objectMapper.createObjectNode().put("home", 1)));
            update.get(1, TimeUnit.SECONDS);

            assertThat(viewStore.get("match", "unsubscribed-entity")).isPresent();
        } finally {
            releaseSend.countDown();
            broadcaster.removeSession(client);
            broadcaster.close();
        }
    }

    @Test
    void slowClientIsClosedWhenItsBoundedOutboundQueueFills() throws Exception {
        RuntimeFixture viewStore =
                new RuntimeFixture(
                        new ViewCases(
                                List.of(
                                        new ViewCases.ViewDefinition(
                                                "match",
                                                Map.of(
                                                        "score",
                                                        List.of(
                                                                new ViewCases.EventMatcher(
                                                                        "match-feed",
                                                                        "score.updated")))))));
        SnapshotBroadcaster broadcaster =
                new SnapshotBroadcaster(objectMapper, viewStore.runtime());
        WebSocketSession client = mock(WebSocketSession.class);
        CountDownLatch sendStarted = new CountDownLatch(1);
        CountDownLatch releaseSend = new CountDownLatch(1);
        when(client.isOpen()).thenReturn(true);
        when(client.getId()).thenReturn("slow-client");
        doAnswer(
                        invocation -> {
                            sendStarted.countDown();
                            releaseSend.await();
                            return null;
                        })
                .when(client)
                .sendMessage(any(TextMessage.class));

        try {
            broadcaster.registerSession(client);
            broadcaster.subscribe(client, "match", "match-42");
            assertThat(sendStarted.await(5, TimeUnit.SECONDS)).isTrue();

            for (int index = 0; index <= 128; index++) {
                viewStore.apply(
                        "match-feed",
                        "score.updated",
                        "match-42",
                        objectMapper.createObjectNode().put("home", index));
            }

            verify(client, timeout(1_000))
                    .close(
                            ArgumentMatchers.argThat(
                                    (CloseStatus status) -> status.getCode() == 1013));
        } finally {
            releaseSend.countDown();
            broadcaster.removeSession(client);
            broadcaster.close();
        }
    }
}
