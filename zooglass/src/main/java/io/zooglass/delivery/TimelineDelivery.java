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
        turns.schedule(turns.now(), 2, action);
    }

    public void closeSession(WebSocketSession session, CloseStatus status) {
        execute(
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
        handoff.writer().finish(handoff, fail);
    }

    public int heldCount() {
        turns.check();
        return held.size();
    }

    public void close() {
        turns.check();
        closed = true;
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
            turns.check();
            long[] id = {0};
            id[0] =
                    turns.schedule(
                            turns.now(),
                            2,
                            () -> {
                                tasks.remove(id[0]);
                                if (!stopped) turn.run();
                            });
            tasks.add(id[0]);
        }

        public void send(OutboundQueue.Frame frame, Consumer<Exception> done) {
            turns.check();
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
            else execute(() -> finish(handoff, false));
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
