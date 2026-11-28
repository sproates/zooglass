package io.zooglass.delivery;

import jakarta.websocket.RemoteEndpoint;
import jakarta.websocket.SendHandler;
import jakarta.websocket.SendResult;
import jakarta.websocket.Session;
import org.springframework.web.socket.adapter.NativeWebSocketSession;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/** Controlled native submission and completion for the real protected socket writers. */
final class NativeWriterSocket {
    record Sent(String payload, SendHandler completion) {
        void finish() { completion.onResult(new SendResult()); }
    }

    final NativeWebSocketSession viewer = mock(NativeWebSocketSession.class);
    final Session nativeSession = mock(Session.class);
    final RemoteEndpoint.Async remote = mock(RemoteEndpoint.Async.class);
    final LinkedBlockingQueue<Sent> sent = new LinkedBlockingQueue<>();

    NativeWriterSocket() {
        when(viewer.isOpen()).thenReturn(true);
        when(viewer.getNativeSession(Session.class)).thenReturn(nativeSession);
        when(nativeSession.getAsyncRemote()).thenReturn(remote);
        doAnswer(call -> {
            sent.add(new Sent(call.getArgument(0), call.getArgument(1)));
            return null;
        }).when(remote).sendText(anyString(), any(SendHandler.class));
    }

    Sent next() throws InterruptedException {
        var next = sent.poll(2, TimeUnit.SECONDS);
        assertThat(next).as("transport handoff").isNotNull();
        return next;
    }
}

