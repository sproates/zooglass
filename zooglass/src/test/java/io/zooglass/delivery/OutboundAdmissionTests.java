package io.zooglass.delivery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.zooglass.delivery.OutboundQueue.Frame;
import io.zooglass.runtime.RuntimeConfiguration.Delivery;

import org.junit.jupiter.api.Test;
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
            var writer =
                    new OutboundWriter(
                            session,
                            executor,
                            new Delivery(null, null, 128, 1048576L),
                            (ignored, error) -> {});
            try {
                var update = new Frame("ordinary update");
                assertThat(writer.enqueueProtected(List.of(update)))
                        .isEqualTo(OutboundQueue.Admission.ACCEPTED);
                assertThat(writing.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(writer.enqueueProtected(Collections.nCopies(127, update)))
                        .isEqualTo(OutboundQueue.Admission.ACCEPTED);

                var pair = List.of(new Frame("acknowledgement"), new Frame("baseline"));
                assertThat(writer.enqueueProtected(pair)).isEqualTo(OutboundQueue.Admission.FULL);
                assertThat(writer.enqueueProtected(List.of(update)))
                        .isEqualTo(OutboundQueue.Admission.ACCEPTED);
            } finally {
                writer.stop();
                release.countDown();
            }
        }
    }
}
