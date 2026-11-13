package io.zooglass.delivery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import io.zooglass.runtime.RuntimeConfiguration.Delivery;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

class ResumableWriterTests {
    static WebSocketSession session(String id) {
        var session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        when(session.getId()).thenReturn(id);
        return session;
    }

    @ParameterizedTest
    @CsvSource({
        "true,coalesceLatestState",
        "false,coalesceLatestState",
        "true,disconnectOnOverflow",
        "false,disconnectOnOverflow"
    })
    void nativeAndControlledDriversUseTheSameQueueOwnershipAndPolicy(
            boolean controlled, String policy) throws Exception {
        var manual = new ControlledDeliveryDriver();
        var nativeHandoffs = new LinkedBlockingQueue<ControlledDeliveryDriver.Handoff>();
        var session = session("slow");
        doAnswer(
                        call -> {
                            var released = new CountDownLatch(1);
                            nativeHandoffs.add(
                                    new ControlledDeliveryDriver.Handoff(
                                            session,
                                            ((TextMessage) call.getArgument(0)).getPayload(),
                                            ignored -> released.countDown()));
                            if (!released.await(5, TimeUnit.SECONDS))
                                throw new AssertionError("Handoff not released");
                            return null;
                        })
                .when(session)
                .sendMessage(any());
        try (DeliveryDriver driver = controlled ? manual : new SocketDeliveryDriver()) {
            var failures = new LinkedBlockingQueue<Exception>();
            var writer =
                    new OutboundWriter(
                            session,
                            driver,
                            new Delivery(null, SlowClientPolicy.select(policy), 2, 4096L),
                            (ignored, failure) -> failures.add(failure),
                            null);
            try {
                writer.enqueueProtected(List.of(new OutboundQueue.Frame("in flight")));
                var first = next(controlled, manual, nativeHandoffs);
                assertThat(first.payload()).isEqualTo("in flight");
                assertThat(writer.enqueueUpdate(1, new OutboundQueue.Frame("one")))
                        .isEqualTo(OutboundQueue.Admission.ACCEPTED);
                assertThat(writer.enqueueUpdate(1, new OutboundQueue.Frame("two")))
                        .isEqualTo(OutboundQueue.Admission.ACCEPTED);
                boolean coalesces = policy.equals("coalesceLatestState");
                assertThat(writer.enqueueUpdate(1, new OutboundQueue.Frame("three")))
                        .isEqualTo(
                                coalesces
                                        ? OutboundQueue.Admission.ACCEPTED
                                        : OutboundQueue.Admission.FULL);
                first.finish();
                for (String expected : coalesces ? List.of("three") : List.of("one", "two")) {
                    var next = next(controlled, manual, nativeHandoffs);
                    assertThat(next.payload()).isEqualTo(expected);
                    next.finish();
                }
                assertThat(failures).isEmpty();
            } finally {
                writer.stop();
            }
        }
    }

    private ControlledDeliveryDriver.Handoff next(
            boolean controlled,
            ControlledDeliveryDriver manual,
            LinkedBlockingQueue<ControlledDeliveryDriver.Handoff> nativeHandoffs)
            throws InterruptedException {
        if (controlled) {
            manual.runTurns();
            return manual.handoffs.remove();
        }
        var next = nativeHandoffs.poll(5, TimeUnit.SECONDS);
        assertThat(next).isNotNull();
        return next;
    }

    @Test
    void sessionInspectionFailureReachesCleanup() {
        var driver = new ControlledDeliveryDriver();
        var session = session("failed inspection");
        var failure = new IllegalStateException("transport unavailable");
        when(session.isOpen()).thenThrow(failure);
        var failures = new ArrayList<Exception>();
        var writer =
                new OutboundWriter(
                        session,
                        driver,
                        new Delivery(null),
                        (ignored, error) -> failures.add(error),
                        null);
        writer.enqueueProtected(List.of(new OutboundQueue.Frame("frame")));
        driver.runTurns();
        assertThat(failures).containsExactly(failure);
        assertThat(driver.handoffs).isEmpty();
    }

    @Test
    void failureAndLateCompletionsCannotResumeStoppedWriter() {
        var driver = new ControlledDeliveryDriver();
        var failures = new ArrayList<Exception>();
        var writer =
                new OutboundWriter(
                        session("failed"),
                        driver,
                        new Delivery(null),
                        (ignored, failure) -> failures.add(failure),
                        null);
        writer.enqueueProtected(
                List.of(new OutboundQueue.Frame("first"), new OutboundQueue.Frame("waiting")));
        driver.runTurns();
        var first = driver.handoffs.remove();
        var failure = new IOException("broken handoff");
        first.completion().accept(failure);
        first.finish();
        driver.runTurns();
        assertThat(failures).containsExactly(failure);
        assertThat(driver.handoffs).isEmpty();
        assertThat(writer.enqueueUpdate(1, new OutboundQueue.Frame("later")))
                .isEqualTo(OutboundQueue.Admission.FULL);
    }

    @Test
    void stopInvalidatesPendingTurnsAndHeldHandoffsAndRejectionReportsOnce() {
        var driver = new ControlledDeliveryDriver();
        var failures = new ArrayList<Exception>();
        Consumer<OutboundWriter> enqueue =
                writer -> writer.enqueueProtected(List.of(new OutboundQueue.Frame("frame")));
        var first =
                new OutboundWriter(
                        session("first"),
                        driver,
                        new Delivery(null),
                        (ignored, failure) -> failures.add(failure),
                        null);
        enqueue.accept(first);
        first.stop();
        driver.runTurns();
        assertThat(driver.handoffs).isEmpty();
        var held =
                new OutboundWriter(
                        session("held"),
                        driver,
                        new Delivery(null),
                        (ignored, failure) -> failures.add(failure),
                        null);
        enqueue.accept(held);
        driver.runTurns();
        var handoff = driver.handoffs.remove();
        held.stop();
        handoff.completion().accept(new IOException("late"));
        driver.runTurns();
        assertThat(failures).isEmpty();
        driver.rejectTurns = true;
        var rejected =
                new OutboundWriter(
                        session("rejected"),
                        driver,
                        new Delivery(null),
                        (ignored, failure) -> failures.add(failure),
                        null);
        enqueue.accept(rejected);
        enqueue.accept(rejected);
        assertThat(failures).hasSize(1);
        assertThat(failures.getFirst())
                .isInstanceOf(java.util.concurrent.RejectedExecutionException.class);
    }
}
