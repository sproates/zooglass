package io.zooglass.delivery;

import io.zooglass.access.ActiveViewGrants;

import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** Test execution adapter only: all queue and subscription decisions stay in production code. */
final class ControlledDeliveryDriver implements DeliveryDriver {
    final ArrayDeque<Runnable> turns = new ArrayDeque<>();
    final ArrayDeque<Handoff> handoffs = new ArrayDeque<>();
    final List<String> closes = new ArrayList<>();
    final List<String> stoppedSessions = new ArrayList<>();
    final List<ControlledWriter> writers = new ArrayList<>();
    boolean closed;
    boolean rejectTurns;

    record Handoff(WebSocketSession session, String payload, Consumer<Exception> completion) {
        void finish() {
            completion.accept(null);
        }
    }

    public Writer writer(WebSocketSession session, ActiveViewGrants grants) {
        if (grants != null)
            throw new IllegalArgumentException("Controlled protected access is unsupported");
        var writer = new ControlledWriter(session);
        writers.add(writer);
        return writer;
    }

    public void execute(Runnable action) {
        if (closed || rejectTurns) throw new java.util.concurrent.RejectedExecutionException();
        turns.add(action);
    }

    public void closeSession(WebSocketSession session, CloseStatus status) {
        execute(() -> closes.add(session.getId() + ":" + status.getCode()));
    }

    void runTurns() {
        int budget = 100;
        while (!turns.isEmpty()) {
            if (--budget == 0) throw new AssertionError("Unbounded writer turns");
            turns.remove().run();
        }
    }

    public void close() {
        closed = true;
        writers.forEach(ControlledWriter::stop);
        turns.clear();
    }

    private final class ControlledWriter implements Writer {
        final WebSocketSession session;
        boolean stopped;

        ControlledWriter(WebSocketSession session) {
            this.session = session;
        }

        public void execute(Runnable turn) {
            ControlledDeliveryDriver.this.execute(
                    () -> {
                        if (!stopped) turn.run();
                    });
        }

        public void send(OutboundQueue.Frame frame, Consumer<Exception> completion) {
            if (!stopped)
                handoffs.add(new Handoff(session, frame.message().getPayload(), completion));
        }

        public void stop() {
            if (!stopped) stoppedSessions.add(session.getId());
            stopped = true;
        }
    }
}
