package io.zooglass.runtime;

import static io.zooglass.runtime.IdentityFixtures.event;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.zooglass.delivery.SnapshotBroadcaster;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

class SnapshotDeliveryTests {
    private static final JsonMapper JSON = new JsonMapper();

    @Test
    void expiryDuringSubscriptionFollowsAcknowledgementAndSendsOneCurrentSnapshot()
            throws Exception {
        var clock = new ReceiptAgeTests.Clock();
        try (var coordinator =
                        new ViewCoordinator(ReceiptAgeTests.config("memory", 5000), "", clock);
                var delivery = new SnapshotBroadcaster(JSON, coordinator)) {
            // Keep the timer from resolving expiry before subscription admission.
            synchronized (coordinator) {
                coordinator.apply(ProgressTests.event(1));
                clock.advance(5000);
                var messages = new LinkedBlockingQueue<JsonNode>();
                var session = session(messages);
                delivery.registerSession(session);
                assertThat(delivery.subscribe(session, "fleet", "car")).isTrue();
                assertThat(take(messages).path("type").asText()).isEqualTo("subscribed");
                assertThat(take(messages).at("/status/fields/position/freshness").asText())
                        .isEqualTo("stale");
                delivery.unsubscribe(session, "fleet", "car");
                assertThat(take(messages).path("type").asText()).isEqualTo("unsubscribed");
                assertThat(messages).isEmpty();
            }
        }
    }

    @Test
    void subscriptionsReceiveInstalledSnapshotsAndRetriesDoNotRepeatDelivery() throws Exception {
        try (var coordinator = new ViewCoordinator(IdentityFixtures.configuration(10, 100, 100));
                var delivery = new SnapshotBroadcaster(JSON, coordinator)) {
            var messages = new LinkedBlockingQueue<JsonNode>();
            var session = session(messages);
            delivery.registerSession(session);
            assertThat(delivery.subscribe(session, "latest", "car")).isTrue();
            assertThat(take(messages).path("type").asText()).isEqualTo("subscribed");
            assertThat(messages).isEmpty();

            var applied = coordinator.apply(event(1));
            var received = take(messages);
            assertThat(received.path("version").longValue()).isEqualTo(applied.version());
            assertThat(received.at("/publicationSequences/position/0").longValue()).isEqualTo(1);
            assertThat(received.path("data"))
                    .isEqualTo(JSON.readTree("{\"position\":{\"value\":1}}"));
            assertThat(coordinator.apply(event(1)).status()).isEqualTo("duplicate");
            assertThat(
                            coordinator
                                    .apply(
                                            IdentityFixtures.parse(
                                                    "fleet",
                                                    "trip-1",
                                                    "car",
                                                    1,
                                                    "position",
                                                    "{\"value\":99}"))
                                    .status())
                    .isEqualTo("rejected");
            coordinator.apply(event(2));
            // A later FIFO snapshot bounds the no-repeat assertion without a timed silence.
            assertThat(take(messages).at("/publicationSequences/position/0").longValue())
                    .isEqualTo(2);
            assertThat(messages).isEmpty();

            delivery.unsubscribe(session, "latest", "car");
            assertThat(take(messages).path("type").asText()).isEqualTo("unsubscribed");
            coordinator.apply(event(3));
            delivery.subscribe(session, "latest", "car");
            assertThat(take(messages).path("type").asText()).isEqualTo("subscribed");
            assertThat(take(messages).at("/publicationSequences/position/0").longValue())
                    .isEqualTo(3);
            assertThat(messages).isEmpty();
        }
    }

    @Test
    void blockedWriterIsEvictedWithoutBlockingHealthyReceipts() throws Exception {
        try (var coordinator = new ViewCoordinator(IdentityFixtures.configuration(10, 1000, 1000));
                var delivery = new SnapshotBroadcaster(JSON, coordinator)) {
            var blocked = new CountDownLatch(1);
            var released = new CountDownLatch(1);
            var slow = mock(WebSocketSession.class);
            when(slow.isOpen()).thenReturn(true);
            when(slow.getId()).thenReturn("blocked");
            doAnswer(
                            call -> {
                                blocked.countDown();
                                try {
                                    new CountDownLatch(1).await();
                                } finally {
                                    released.countDown();
                                }
                                return null;
                            })
                    .when(slow)
                    .sendMessage(any());
            var messages = new LinkedBlockingQueue<JsonNode>();
            var healthy = session(messages);
            delivery.registerSession(slow);
            delivery.registerSession(healthy);
            delivery.subscribe(slow, "latest", "car");
            delivery.subscribe(healthy, "latest", "car");
            take(messages);
            assertThat(blocked.await(5, TimeUnit.SECONDS)).isTrue();
            for (int sequence = 1; sequence <= 160; sequence++) {
                coordinator.apply(event(sequence));
                assertThat(take(messages).at("/publicationSequences/position/0").longValue())
                        .isEqualTo(sequence);
            }
            assertThat(released.await(5, TimeUnit.SECONDS)).isTrue();
            verify(slow, timeout(5000)).close(any());
            assertThat(
                            coordinator
                                    .snapshot("latest", "car")
                                    .orElseThrow()
                                    .data()
                                    .get("position")
                                    .path("publicationSequence")
                                    .longValue())
                    .isEqualTo(160);
        }
    }

    @Test
    void subscribeAndConcurrentCommitCannotLeaveTheViewerBehind() throws Exception {
        try (var coordinator = new ViewCoordinator(IdentityFixtures.configuration(10, 100, 100));
                var delivery = new SnapshotBroadcaster(JSON, coordinator)) {
            coordinator.apply(event(1));
            var messages = new LinkedBlockingQueue<JsonNode>();
            var session = session(messages);
            delivery.registerSession(session);
            var start = new CountDownLatch(1);
            try (var tasks = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
                var subscription =
                        tasks.submit(
                                () -> {
                                    start.await();
                                    return delivery.subscribe(session, "latest", "car");
                                });
                var publication =
                        tasks.submit(
                                () -> {
                                    start.await();
                                    return coordinator.apply(event(2));
                                });
                start.countDown();
                assertThat(subscription.get(5, TimeUnit.SECONDS)).isTrue();
                publication.get(5, TimeUnit.SECONDS);
            }
            assertThat(take(messages).path("type").asText()).isEqualTo("subscribed");
            var versions = new ArrayList<Long>();
            do {
                versions.add(take(messages).path("version").longValue());
            } while (versions.getLast() < 2);
            assertThat(versions).isSorted().doesNotHaveDuplicates();
            assertThat(messages).isEmpty();
        }
    }

    private static WebSocketSession session(LinkedBlockingQueue<JsonNode> messages)
            throws Exception {
        var session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        when(session.getId()).thenReturn("healthy");
        doAnswer(
                        call -> {
                            org.springframework.web.socket.TextMessage message =
                                    call.getArgument(0);
                            messages.add(JSON.readTree(message.getPayload()));
                            return null;
                        })
                .when(session)
                .sendMessage(any());
        return session;
    }

    private static JsonNode take(LinkedBlockingQueue<JsonNode> messages) throws Exception {
        var message = messages.poll(5, TimeUnit.SECONDS);
        assertThat(message).as("next bounded outbound message").isNotNull();
        return message;
    }
}
