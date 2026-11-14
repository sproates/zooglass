package io.zooglass.delivery;

import io.zooglass.access.ActiveViewGrants;
import io.zooglass.access.AdmissionAccess;
import io.zooglass.runtime.ViewCoordinator;
import io.zooglass.simulation.TurnContext;

import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/** POC adapter: defers real writer turns and holds transport handoffs without queue emulation. */
public final class TimelineDelivery implements DeliveryDriver {
    private static final int LIFECYCLE_PHASE = 0;
    private static final int RUNTIME_PHASE = 1;
    private static final int ARRIVAL_PHASE = 2;

    private final TurnContext turns;
    private final Map<String, ModelWriter> writers = new LinkedHashMap<>();
    private final Set<Long> tasks = new LinkedHashSet<>();
    private boolean closed;

    private record Handoff(OutboundQueue.Frame frame, Consumer<Exception> done) {}

    public TimelineDelivery(TurnContext turns) {
        this.turns = turns;
    }

    public SnapshotBroadcaster broadcaster(ObjectMapper json, ViewCoordinator runtime) {
        return new SnapshotBroadcaster(json, runtime, new AdmissionAccess(), this);
    }

    @Override
    public Writer writer(WebSocketSession session, ActiveViewGrants grants) {
        turns.check();
        if (closed || grants != null)
            throw new IllegalArgumentException("Unsupported delivery composition");
        var writer = new ModelWriter(session);
        if (writers.putIfAbsent(session.getId(), writer) != null)
            throw new IllegalStateException("Duplicate writer for session " + session.getId());
        return writer;
    }

    @Override
    public void execute(Runnable action) {
        deferDriverTask(RUNTIME_PHASE, action);
    }

    private void deferDriverTask(int phase, Runnable action) {
        turns.check();
        if (closed) throw new IllegalStateException("Closed delivery driver");
        defer(phase, tasks, action);
    }

    private void defer(int phase, Set<Long> ownerTasks, Runnable action) {
        long[] id = {0};
        id[0] =
                turns.schedule(
                        turns.now(),
                        phase,
                        () -> {
                            ownerTasks.remove(id[0]);
                            action.run();
                        });
        ownerTasks.add(id[0]);
    }

    @Override
    public void closeSession(WebSocketSession session, CloseStatus status) {
        deferDriverTask(
                LIFECYCLE_PHASE,
                () -> {
                    try {
                        if (session.isOpen()) session.close(status);
                    } catch (IOException failure) {
                        throw new IllegalStateException("Could not close modelled session", failure);
                    }
                });
    }

    public void stall(String session) {
        writerFor(session).stalled = true;
    }

    public void release(String session, boolean fail) {
        writerFor(session).release(fail);
    }

    private ModelWriter writerFor(String session) {
        turns.check();
        var writer = writers.get(session);
        if (writer == null) throw new IllegalArgumentException("No writer for session " + session);
        return writer;
    }

    public int heldCount() {
        turns.check();
        int count = 0;
        for (var writer : writers.values()) {
            if (writer.held != null) count++;
        }
        return count;
    }

    @Override
    public void close() {
        turns.check();
        if (closed) return;
        closed = true;
        tasks.forEach(turns::cancel);
        tasks.clear();
        List.copyOf(writers.values()).forEach(ModelWriter::stop);
    }

    private final class ModelWriter implements Writer {
        private final WebSocketSession session;
        private final Set<Long> tasks = new LinkedHashSet<>();
        private boolean stopped;
        private boolean stalled;
        private Handoff held;

        ModelWriter(WebSocketSession session) {
            this.session = session;
        }

        @Override
        public void execute(Runnable turn) {
            defer(RUNTIME_PHASE, turn);
        }

        private void defer(int phase, Runnable turn) {
            turns.check();
            if (!stopped) TimelineDelivery.this.defer(phase, tasks, turn);
        }

        @Override
        public void send(OutboundQueue.Frame frame, Consumer<Exception> done) {
            turns.check();
            turns.perturb("writer-handoff");
            if (stopped) return;
            var handoff = new Handoff(frame, done);
            turns.effect(
                    Map.of(
                            "kind",
                            "handoff",
                            "session",
                            session.getId(),
                            "wire",
                            frame.message().getPayload()));
            if (stalled) held = handoff;
            else defer(ARRIVAL_PHASE, () -> finish(handoff, false));
        }

        private void release(boolean fail) {
            var handoff = held;
            if (handoff == null) throw new IllegalArgumentException("No held handoff");
            defer(ARRIVAL_PHASE, () -> finish(handoff, fail));
            held = null;
            stalled = false;
        }

        private void finish(Handoff handoff, boolean fail) {
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
            handoff.done().accept(fail ? new IOException("Modelled handoff failure") : null);
        }

        @Override
        public void stop() {
            turns.check();
            if (stopped) return;
            stopped = true;
            tasks.forEach(turns::cancel);
            tasks.clear();
            held = null;
            writers.remove(session.getId(), this);
        }
    }
}
