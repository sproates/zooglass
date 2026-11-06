package io.zooglass.delivery;

import io.zooglass.runtime.RuntimeConfiguration.Delivery;
import io.zooglass.access.ActiveViewGrants;

import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.function.BiConsumer;

/** Owns one bounded queue and writer task. Failure callbacks acquire no writer lock. */
final class OutboundWriter {

    private final BiConsumer<OutboundWriter, Exception> onFailure;
    private final WebSocketSession session;
    private final OutboundQueue queue;
    private final Future<?> task;
    private final AuthorisedSocketTransport protectedTransport;
    private final ActiveViewGrants grants;

    OutboundWriter(
            WebSocketSession session,
            ExecutorService executor,
            Delivery settings,
            BiConsumer<OutboundWriter, Exception> onFailure) {
        this(session, executor, settings, onFailure, null);
    }

    OutboundWriter(WebSocketSession session, ExecutorService executor, Delivery settings,
            BiConsumer<OutboundWriter, Exception> onFailure, ActiveViewGrants grants) {
        this.grants = grants;
        this.protectedTransport = grants == null ? null : new AuthorisedSocketTransport(session, grants);
        this.session = session;
        this.queue = new OutboundQueue(settings);
        this.onFailure = onFailure;
        this.task = executor.submit(this::writeMessages);
    }

    OutboundQueue.Admission enqueueProtected(List<OutboundQueue.Frame> batch) {
        discardSuperseded();
        return queue.offerProtected(batch);
    }

    OutboundQueue.Admission enqueueUpdate(long generation, OutboundQueue.Frame frame) {
        discardSuperseded();
        return queue.offerUpdate(generation, frame);
    }

    private void discardSuperseded() {
        if (grants != null) {
            queue.discard(frame -> grants.superseded(frame.lease()));
        }
    }

    void stop() {
        queue.stop();
        task.cancel(true);
    }

    private void writeMessages() {
        try {
            while (session.isOpen()) {
                var frame = queue.take();
                if (frame == null) {
                    return;
                }
                if (protectedTransport == null) {
                    session.sendMessage(frame.message());
                } else {
                    protectedTransport.send(frame);
                }
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        } catch (IOException | RuntimeException exception) {
            onFailure.accept(this, exception);
        }
    }
}
