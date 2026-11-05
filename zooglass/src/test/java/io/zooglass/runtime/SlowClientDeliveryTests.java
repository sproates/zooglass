package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.zooglass.delivery.CoalesceLatestState;
import io.zooglass.delivery.SnapshotBroadcaster;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

class SlowClientDeliveryTests {
    private static final JsonMapper JSON = new JsonMapper();

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void replacesOnlyPendingUpdatesWithinOneSubscriptionGeneration(boolean unsubscribe)
            throws Exception {
        try (var runtime = configured(12, 32768);
                var broadcaster = new SnapshotBroadcaster(JSON, runtime)) {
            var entered = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var messages = new LinkedBlockingQueue<JsonNode>();
            var client = mock(WebSocketSession.class);
            when(client.isOpen()).thenReturn(true);
            doAnswer(
                            call -> {
                                entered.countDown();
                                release.await();
                                TextMessage frame = call.getArgument(0);
                                messages.add(JSON.readTree(frame.getPayload()));
                                return null;
                            })
                    .when(client)
                    .sendMessage(any());

            try {
                broadcaster.registerSession(client);
                broadcaster.subscribe(client, "latest", "car");
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                runtime.apply(IdentityFixtures.event(1));
                broadcaster.sendError(client, "control");
                runtime.apply(IdentityFixtures.event(2));
                if (unsubscribe) {
                    broadcaster.unsubscribe(client, "latest", "car");
                }
                broadcaster.subscribe(client, "latest", "car");
                runtime.apply(IdentityFixtures.event(3));
                runtime.apply(IdentityFixtures.event(4));
                broadcaster.unsubscribe(client, "latest", "car");
                release.countDown();

                expect(messages, "subscribed");
                expectVersion(messages, 0);
                expect(messages, "error");
                expectVersion(messages, 2);
                if (unsubscribe) {
                    expect(messages, "unsubscribed");
                }
                expect(messages, "subscribed");
                expectVersion(messages, 2);
                expectVersion(messages, 4);
                expect(messages, "unsubscribed");
                verify(client, never()).close(any());
            } finally {
                release.countDown();
            }
        }
    }

    @Test
    void oversizedBaselineClosesWithoutSendingHalfThePair() throws Exception {
        try (var runtime = configured(2, 10);
                var broadcaster = new SnapshotBroadcaster(JSON, runtime)) {
            var client = mock(WebSocketSession.class);
            when(client.isOpen()).thenReturn(true);
            broadcaster.registerSession(client);
            broadcaster.subscribe(client, "latest", "car");
            verify(client, timeout(5000)).close(CloseStatus.TOO_BIG_TO_PROCESS);
            verify(client, never()).sendMessage(any());
            assertThat(runtime.apply(IdentityFixtures.event(1)).status()).isEqualTo("applied");
        }
    }

    @Test
    void openingPairThatFitsAloneButCannotJoinTheQueueClosesWith1013() throws Exception {
        try (var runtime = configured(2, 32768);
                var broadcaster = new SnapshotBroadcaster(JSON, runtime)) {
            var writing = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var client = mock(WebSocketSession.class);
            when(client.isOpen()).thenReturn(true);
            doAnswer(
                            call -> {
                                writing.countDown();
                                release.await();
                                return null;
                            })
                    .when(client)
                    .sendMessage(any());
            try {
                broadcaster.registerSession(client);
                broadcaster.subscribe(client, "latest", "car");
                assertThat(writing.await(5, TimeUnit.SECONDS)).isTrue();
                // The first baseline still occupies one of the two waiting slots.
                broadcaster.subscribe(client, "latest", "other");
                verify(client, timeout(5000)).close(argThat(status -> status.getCode() == 1013));
                verify(client).sendMessage(any());
            } finally {
                release.countDown();
            }
        }
    }

    private static ViewCoordinator configured(int slots, long bytes) {
        var base = IdentityFixtures.configuration(10, 100, 100);
        var delivery =
                new RuntimeConfiguration.Delivery(null, CoalesceLatestState.INSTANCE, slots, bytes);
        return new ViewCoordinator(
                new RuntimeConfiguration(
                        base.contractVersion(),
                        base.storage(),
                        base.maxStreams(),
                        base.identityWindow(),
                        base.maxHistoryEntries(),
                        base.sources(),
                        base.views(),
                        delivery));
    }

    private static JsonNode expect(LinkedBlockingQueue<JsonNode> messages, String type)
            throws InterruptedException {
        var message = messages.poll(5, TimeUnit.SECONDS);
        assertThat(message).as(type).isNotNull();
        assertThat(message.path("type").asText()).isEqualTo(type);
        return message;
    }

    private static void expectVersion(LinkedBlockingQueue<JsonNode> messages, long version)
            throws InterruptedException {
        assertThat(expect(messages, "view-update").get("version").longValue()).isEqualTo(version);
    }
}
