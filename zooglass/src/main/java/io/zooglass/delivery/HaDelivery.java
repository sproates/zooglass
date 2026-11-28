package io.zooglass.delivery;

import io.zooglass.access.ActiveViewGrants;
import io.zooglass.runtime.RuntimeConfiguration;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;
import java.util.function.Supplier;

/** Uses the configured waiting queue. Only its single socket writer requests a handoff permit. */
public final class HaDelivery {
    public record Pending(int maximumBytes, ActiveViewGrants.Lease lease, BooleanSupplier current, Supplier<String> admit) {
        private OutboundQueue.Frame frame() { return new OutboundQueue.Frame(null, maximumBytes, lease, this); }
    }

    private final OutboundQueue queue;
    private final WebSocketSession socket;
    private final AuthorisedSocketTransport protectedSocket;
    private final IntConsumer failed;
    private final Thread writer;

    public HaDelivery(RuntimeConfiguration.Delivery settings, WebSocketSession socket,
            ActiveViewGrants grants, IntConsumer failed) {
        queue = new OutboundQueue(settings);
        this.socket = socket;
        this.failed = failed;
        protectedSocket = grants == null ? null : new AuthorisedSocketTransport(socket, grants);
        writer = Thread.ofVirtual().name("zooglass-ha-socket").unstarted(this::write);
    }

    public void start() { writer.start(); }

    public void batch(List<Pending> pending) {
        check(queue.offerProtected(pending.stream().map(Pending::frame).toList()));
    }

    public void update(long membership, Pending frame) { check(queue.offerUpdate(membership, frame.frame())); }

    private void check(OutboundQueue.Admission result) {
        if (result != OutboundQueue.Admission.ACCEPTED) failed.accept(result == OutboundQueue.Admission.TOO_LARGE ? 1009 : 1013);
    }

    public void discardStale() { queue.discard(frame -> !frame.pending().current().getAsBoolean()); }

    private void write() {
        try {
            OutboundQueue.Frame item;
            while ((item = queue.take()) != null) {
                var pending = item.pending();
                if (!pending.current().getAsBoolean()) continue;
                var body = pending.admit().get();
                if (!pending.current().getAsBoolean()) continue;
                var text = new TextMessage(body);
                if (protectedSocket == null) socket.sendMessage(text);
                else protectedSocket.send(new OutboundQueue.Frame(text, item.bytes(), item.lease()), pending.current());
            }
        } catch (IOException | RuntimeException failure) {
            failed.accept(1013);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    public void stop() {
        queue.stop();
        writer.interrupt();
    }
}
