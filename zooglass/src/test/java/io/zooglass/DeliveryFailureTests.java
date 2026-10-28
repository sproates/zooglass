package io.zooglass;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class DeliveryFailureTests {
    private final JsonMapper json = JsonMapper.builder().build();

    @Test
    void serializationFailureRemovesTheSessionAndItCanBeRegisteredAgain() throws Exception {
        ObjectMapper serializer = mock(ObjectMapper.class);
        when(serializer.writeValueAsString(any())).thenThrow(new IllegalStateException("cannot encode"));
        WebSocketSession client = client();
        try (var broadcaster = new LiveViewBroadcaster(serializer, store())) {
            broadcaster.registerSession(client);
            broadcaster.subscribe(client, "position", "bus");
            broadcaster.apply("feed", "position", "bus", json.createObjectNode().put("sequence", 1));
            verify(serializer, times(1)).writeValueAsString(any());
            verify(client, never()).sendMessage(any());
            // Encoding errors remove ownership but do not request a socket close.
            verify(client, never()).close(any(CloseStatus.class));
            doReturn("recovered").when(serializer).writeValueAsString(any());
            var delivered = new CountDownLatch(1);
            doAnswer(invocation -> { delivered.countDown(); return null; }).when(client).sendMessage(any());
            broadcaster.registerSession(client);
            broadcaster.sendError(client, "test");
            assertThat(delivered.await(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void writeAndCloseFailuresDoNotPreventHealthyDeliveryOrFutureRegistration() throws Exception {
        WebSocketSession failed = client();
        WebSocketSession healthy = client();
        var closeAttempt = new CountDownLatch(1);
        var delivered = new LinkedBlockingQueue<String>();
        doThrow(new IOException("broken write")).when(failed).sendMessage(any());
        doAnswer(invocation -> {
            assertThat(((CloseStatus) invocation.getArgument(0)).getCode()).isEqualTo(1013);
            closeAttempt.countDown();
            throw new IOException("broken close");
        }).when(failed).close(any(CloseStatus.class));
        doAnswer(invocation -> {
            delivered.add(((TextMessage) invocation.getArgument(0)).getPayload());
            return null;
        }).when(healthy).sendMessage(any());
        try (var broadcaster = new LiveViewBroadcaster(json, store())) {
            broadcaster.registerSession(failed);
            broadcaster.subscribe(failed, "position", "bus");
            assertThat(closeAttempt.await(5, TimeUnit.SECONDS)).isTrue();
            broadcaster.registerSession(healthy);
            broadcaster.subscribe(healthy, "position", "bus");
            assertThat(delivered.poll(5, TimeUnit.SECONDS)).contains("subscribed");
            broadcaster.apply("feed", "position", "bus", json.createObjectNode().put("sequence", 1));
            assertThat(json.readTree(delivered.poll(5, TimeUnit.SECONDS))
                    .at("/data/position/sequence").intValue()).isEqualTo(1);
            verify(failed, times(1)).sendMessage(any());
            doAnswer(invocation -> {
                delivered.add(((TextMessage) invocation.getArgument(0)).getPayload());
                return null;
            }).when(failed).sendMessage(any());
            broadcaster.registerSession(failed);
            broadcaster.sendError(failed, "registered again");
            assertThat(delivered.poll(5, TimeUnit.SECONDS)).contains("registered again");
        }
    }

    @Test
    void lateFailureFromAnOldWriterCannotRemoveItsReplacement() throws Exception {
        WebSocketSession client = client();
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var oldThread = new AtomicReference<Thread>();
        var calls = new AtomicInteger();
        var delivered = new LinkedBlockingQueue<String>();
        doAnswer(invocation -> {
            if (calls.getAndIncrement() == 0) {
                oldThread.set(Thread.currentThread());
                entered.countDown();
                // Model an I/O operation reporting failure after cancellation.
                boolean released = false;
                while (!released) {
                    try { release.await(); released = true; }
                    catch (InterruptedException ignored) { }
                }
                throw new IOException("late old-writer failure");
            }
            delivered.add(((TextMessage) invocation.getArgument(0)).getPayload());
            return null;
        }).when(client).sendMessage(any());
        try (var broadcaster = new LiveViewBroadcaster(json, store())) {
            broadcaster.registerSession(client);
            broadcaster.subscribe(client, "position", "bus");
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
            broadcaster.removeSession(client);
            broadcaster.registerSession(client);
            broadcaster.subscribe(client, "position", "bus");
            assertThat(delivered.poll(5, TimeUnit.SECONDS)).contains("subscribed");
            release.countDown();
            oldThread.get().join(5000);
            assertThat(oldThread.get().isAlive()).isFalse();
            broadcaster.apply("feed", "position", "bus", json.createObjectNode().put("sequence", 2));
            assertThat(json.readTree(delivered.poll(5, TimeUnit.SECONDS))
                    .at("/data/position/sequence").intValue()).isEqualTo(2);
            verify(client, never()).close(any(CloseStatus.class));
        } finally {
            release.countDown();
        }
    }

    private WebSocketSession client() {
        var client = mock(WebSocketSession.class);
        when(client.isOpen()).thenReturn(true);
        return client;
    }

    private ViewStore store() {
        return new ViewStore(new ViewConfiguration(List.of(
                new ViewConfiguration.ViewDefinition("position", Map.of(
                        "position", List.of(new ViewConfiguration.EventMatcher("feed", "position")))))));
    }
}
