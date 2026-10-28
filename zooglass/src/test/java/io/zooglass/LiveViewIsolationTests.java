package io.zooglass;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LiveViewIsolationTests {
    @Test
    void queueLimitIsPerClientAndRemovalStopsFutureDelivery() throws Exception {
        var json = JsonMapper.builder().build();
        var store = new ViewStore(new ViewConfiguration(List.of(
                new ViewConfiguration.ViewDefinition("position", Map.of(
                        "position", List.of(new ViewConfiguration.EventMatcher("feed", "position")))))));
        var slow = mock(WebSocketSession.class);
        var healthy = mock(WebSocketSession.class);
        when(slow.getId()).thenReturn("blocked");
        when(healthy.getId()).thenReturn("healthy");
        when(slow.isOpen()).thenReturn(true);
        when(healthy.isOpen()).thenReturn(true);
        var blocked = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var interrupted = new CountDownLatch(1);
        var delivered = new LinkedBlockingQueue<String>();
        var healthyStopped = new CountDownLatch(1);
        doAnswer(invocation -> {
            blocked.countDown();
            try {
                release.await();
            } catch (InterruptedException exception) {
                interrupted.countDown();
                throw exception;
            }
            return null;
        }).when(slow).sendMessage(any(TextMessage.class));
        doAnswer(invocation -> {
            String message = ((TextMessage) invocation.getArgument(0)).getPayload();
            delivered.add(message);
            var sequence = json.readTree(message).at("/data/position/sequence");
            if (sequence.isNumber() && sequence.intValue() == 129) {
                try {
                    release.await();
                } catch (InterruptedException exception) {
                    healthyStopped.countDown();
                    throw exception;
                }
            }
            return null;
        }).when(healthy).sendMessage(any(TextMessage.class));

        try (var broadcaster = new LiveViewBroadcaster(json, store)) {
            broadcaster.registerSession(slow);
            broadcaster.registerSession(healthy);
            broadcaster.subscribe(slow, "position", "bus");
            assertThat(blocked.await(5, TimeUnit.SECONDS)).isTrue();
            broadcaster.subscribe(healthy, "position", "bus");
            assertThat(delivered.poll(5, TimeUnit.SECONDS)).contains("subscribed");
            // The blocked acknowledgement occupies the writer, leaving exactly
            // 128 queue slots. Every event also has to reach the healthy peer.
            for (int sequence = 1; sequence <= 128; sequence++) {
                broadcaster.apply("feed", "position", "bus", json.createObjectNode().put("sequence", sequence));
                String message = delivered.poll(5, TimeUnit.SECONDS);
                assertThat(message).isNotNull();
                assertThat(json.readTree(message).at("/data/position/sequence").intValue()).isEqualTo(sequence);
            }
            verify(slow, never()).close(any(CloseStatus.class));
            broadcaster.apply("feed", "position", "bus", json.createObjectNode().put("sequence", 129));
            assertThat(json.readTree(delivered.poll(5, TimeUnit.SECONDS))
                    .at("/data/position/sequence").intValue()).isEqualTo(129);
            verify(slow, timeout(5000)).close(argThat(status -> status.getCode() == 1013));
            assertThat(interrupted.await(5, TimeUnit.SECONDS)).isTrue();
            verify(slow, times(1)).sendMessage(any(TextMessage.class));
            verify(healthy, never()).close(any(CloseStatus.class));

            broadcaster.removeSession(healthy);
            assertThat(healthyStopped.await(5, TimeUnit.SECONDS)).isTrue();
            broadcaster.apply("feed", "position", "bus", json.createObjectNode().put("sequence", 130));
            // Removal returns synchronously before this update. Neither removed
            // session may receive it; the store must still advance.
            assertThat(delivered).isEmpty();
            verify(healthy, times(130)).sendMessage(any(TextMessage.class));
            assertThat(store.get("position", "bus").orElseThrow().data().get("position")
                    .get("sequence").intValue()).isEqualTo(130);
        } finally {
            release.countDown();
        }
    }
}
