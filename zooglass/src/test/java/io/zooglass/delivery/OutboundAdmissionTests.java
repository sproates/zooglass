package io.zooglass.delivery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

class OutboundAdmissionTests {
    @Test
    void oneFreeSlotCannotAdmitHalfOfTheSubscriptionPair() throws Exception {
        var session = mock(WebSocketSession.class);
        var writing = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        when(session.isOpen()).thenReturn(true);
        doAnswer(
                        call -> {
                            writing.countDown();
                            release.await();
                            return null;
                        })
                .when(session)
                .sendMessage(any());

        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var writer = new OutboundWriter(session, executor, (ignored, error) -> {});
            try {
                var update = new TextMessage("ordinary update");
                assertThat(writer.enqueue(List.of(update))).isTrue();
                assertThat(writing.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(writer.enqueue(Collections.nCopies(127, update))).isTrue();

                var pair = List.of(new TextMessage("acknowledgement"), new TextMessage("baseline"));
                assertThat(writer.enqueue(pair)).isFalse();
                assertThat(writer.enqueue(List.of(update))).isTrue();
            } finally {
                writer.stop();
                release.countDown();
            }
        }
    }
}
