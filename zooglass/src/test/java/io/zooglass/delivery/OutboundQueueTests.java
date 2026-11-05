package io.zooglass.delivery;

import static io.zooglass.delivery.OutboundQueue.Admission.ACCEPTED;
import static io.zooglass.delivery.OutboundQueue.Admission.FULL;
import static io.zooglass.delivery.OutboundQueue.Admission.TOO_LARGE;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.runtime.RuntimeConfiguration.Delivery;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.web.socket.TextMessage;

import java.util.List;

@Timeout(5)
class OutboundQueueTests {
    private static final TextMessage A1 = new TextMessage("猫");
    private static final TextMessage A2 = new TextMessage("🐘");
    private static final TextMessage B1 = new TextMessage("b");

    @Test
    void pairUsesCombinedUtf8SizeAndLeavesNoPartialReply() throws Exception {
        var pair = List.of(A1, A2);
        for (var policy : List.of(DisconnectOnOverflow.INSTANCE, CoalesceLatestState.INSTANCE)) {
            var shortQueue = queue(policy, 2, 6);
            assertThat(shortQueue.offerProtected(pair)).isEqualTo(TOO_LARGE);
            assertThat(shortQueue.offerUpdate(1, B1)).isEqualTo(ACCEPTED);
            assertThat(shortQueue.take()).isSameAs(B1);

            var exact = queue(policy, 3, 7);
            assertThat(exact.offerUpdate(1, B1)).isEqualTo(ACCEPTED);
            assertThat(exact.offerProtected(pair)).isEqualTo(FULL);
            assertThat(exact.take()).isSameAs(B1);
            assertThat(exact.offerProtected(pair)).isEqualTo(ACCEPTED);
            assertThat(exact.take()).isSameAs(A1);
            assertThat(exact.take()).isSameAs(A2);
        }
    }

    @Test
    void replacementMovesToTailAndReleasesItsPredecessorsBytes() throws Exception {
        var queue = queue(CoalesceLatestState.INSTANCE, 2, 5);
        assertThat(queue.offerUpdate(1, A1)).isEqualTo(ACCEPTED);
        assertThat(queue.offerUpdate(2, B1)).isEqualTo(ACCEPTED);
        assertThat(queue.offerUpdate(1, A2)).isEqualTo(ACCEPTED);
        assertThat(queue.take()).isSameAs(B1);
        assertThat(queue.take()).isSameAs(A2);
    }

    @Test
    void fifoKeepsBothVersionsAndCoalescingAlwaysKeepsOnlyTheNewest() throws Exception {
        var fifo = queue(DisconnectOnOverflow.INSTANCE, 2, 8);
        assertThat(fifo.offerUpdate(1, A1)).isEqualTo(ACCEPTED);
        assertThat(fifo.offerUpdate(1, A2)).isEqualTo(ACCEPTED);
        assertThat(fifo.offerUpdate(2, B1)).isEqualTo(FULL);
        assertThat(fifo.take()).isSameAs(A1);
        assertThat(fifo.take()).isSameAs(A2);

        var latest = queue(CoalesceLatestState.INSTANCE, 2, 8);
        assertThat(latest.offerUpdate(1, A1)).isEqualTo(ACCEPTED);
        assertThat(latest.offerUpdate(1, A2)).isEqualTo(ACCEPTED);
        assertThat(latest.offerUpdate(2, B1)).isEqualTo(ACCEPTED);
        assertThat(latest.take()).isSameAs(A2);
        assertThat(latest.take()).isSameAs(B1);
    }

    @Test
    void replacementCannotBypassByteLimitOrDisplaceControlMessages() throws Exception {
        var queue = queue(CoalesceLatestState.INSTANCE, 3, 4);
        assertThat(queue.offerUpdate(1, A1)).isEqualTo(ACCEPTED);
        assertThat(queue.offerProtected(List.of(B1))).isEqualTo(ACCEPTED);
        assertThat(queue.offerUpdate(1, A2)).isEqualTo(FULL);
        assertThat(queue.offerUpdate(1, new TextMessage("12345"))).isEqualTo(TOO_LARGE);
        assertThat(queue.take()).isSameAs(A1);
        assertThat(queue.take()).isSameAs(B1);
    }

    private static OutboundQueue queue(SlowClientPolicy policy, int messages, long bytes) {
        return new OutboundQueue(new Delivery(null, policy, messages, bytes));
    }
}
