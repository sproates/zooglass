package io.zooglass.delivery;

import io.zooglass.access.*;
import io.zooglass.runtime.ViewCoordinator;
import io.zooglass.simulation.*;

import org.springframework.web.socket.*;

import tools.jackson.databind.ObjectMapper;

import java.util.*;
import java.util.function.Consumer;

/** POC adapter: defers real writer turns and holds transport handoffs without queue emulation. */
public final class TimelineDelivery implements DeliveryDriver {
    private final TurnContext turns;
    private final Map<String, ModelWriter> writers = new LinkedHashMap<>();
    private final Map<String, Handoff> held = new LinkedHashMap<>();
    private final Set<String> stalled = new LinkedHashSet<>();
    private final Set<Long> tasks = new LinkedHashSet<>();
    private boolean closed;

    private record Handoff(
            ModelWriter writer, OutboundQueue.Frame frame, Consumer<Exception> done) {}

    public TimelineDelivery(TurnContext turns) {
        this.turns = turns;
    }

    public SnapshotBroadcaster broadcaster(ObjectMapper json, ViewCoordinator runtime) {
        return new SnapshotBroadcaster(json, runtime, new AdmissionAccess(), this);
    }

    public Writer writer(WebSocketSession session, ActiveViewGrants grants) {
        turns.check();
        if (closed || grants != null)
            throw new IllegalArgumentException("Unsupported delivery composition");
        var writer = new ModelWriter(session);
        writers.put(session.getId(), writer);
        return writer;
    }

    public void execute(Runnable action) {
        defer(1, action);
    }

    private void defer(int phase, Runnable action) {
        turns.check();
        if (closed) throw new IllegalStateException("Closed delivery driver");
        long[] id = {0};
        id[0] =
                turns.schedule(
                        turns.now(),
                        phase,
                        () -> {
                            tasks.remove(id[0]);
                            action.run();
                        });
        tasks.add(id[0]);
    }

    public void closeSession(WebSocketSession session, CloseStatus status) {
        defer(
                0,
                () -> {
                    try {
                        session.close(status);
                    } catch (java.io.IOException e) {
                        throw new IllegalStateException(e);
                    }
                });
    }

    public void stall(String session) {
        turns.check();
        stalled.add(session);
    }

    public void release(String session, boolean fail) {
        turns.check();
        stalled.remove(session);
        var handoff = held.remove(session);
        if (handoff == null) throw new IllegalArgumentException("No held handoff");
        handoff.writer().defer(2, () -> handoff.writer().finish(handoff, fail));
    }

    public int heldCount() {
        turns.check();
        return held.size();
    }

    public void close() {
        turns.check();
        if (closed) return;
        closed = true;
        for (long id : List.copyOf(tasks)) turns.cancel(id);
        tasks.clear();
        writers.values().forEach(ModelWriter::stop);
        writers.clear();
        held.clear();
        stalled.clear();
    }

    private final class ModelWriter implements Writer {
        final WebSocketSession session;
        final Set<Long> tasks = new LinkedHashSet<>();
        boolean stopped;

        ModelWriter(WebSocketSession session) {
            this.session = session;
        }

        public void execute(Runnable turn) {
            defer(1, turn);
        }

        void defer(int phase, Runnable turn) {
            turns.check();
            if (stopped) return;
            long[] id = {0};
            id[0] =
                    turns.schedule(
                            turns.now(),
                            phase,
                            () -> {
                                tasks.remove(id[0]);
                                if (!stopped) turn.run();
                            });
            tasks.add(id[0]);
        }

        public void send(OutboundQueue.Frame frame, Consumer<Exception> done) {
            turns.check();
            turns.perturb("writer-handoff");
            if (stopped) return;
            var handoff = new Handoff(this, frame, done);
            turns.effect(
                    Map.of(
                            "kind",
                            "handoff",
                            "session",
                            session.getId(),
                            "wire",
                            frame.message().getPayload()));
            if (stalled.contains(session.getId())) held.put(session.getId(), handoff);
            else defer(2, () -> finish(handoff, false));
        }

        void finish(Handoff handoff, boolean fail) {
            turns.check();
            if (stopped) return;
            if (!fail)
                turns.effect(
                        Map.of(
                                "kind",
                                "frame",
                                "session",
                                session.getId(),
                                "wire",
                                handoff.frame().message().getPayload()));
            handoff.done()
                    .accept(fail ? new java.io.IOException("Modelled handoff failure") : null);
        }

        public void stop() {
            turns.check();
            stopped = true;
            for (long id : List.copyOf(tasks)) turns.cancel(id);
            tasks.clear();
            held.remove(session.getId());
        }
    }
}
