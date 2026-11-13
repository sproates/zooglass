package io.zooglass.delivery;

import io.zooglass.access.ActiveViewGrants;
import io.zooglass.runtime.RuntimeConfiguration.Delivery;

import org.springframework.web.socket.WebSocketSession;

import java.util.List;
import java.util.function.BiConsumer;

/** One bounded queue and at most one owned handoff; callbacks acquire no writer lock. */
final class OutboundWriter {
    private final BiConsumer<OutboundWriter, Exception> onFailure;
    private final WebSocketSession session;
    private final OutboundQueue queue;
    private final DeliveryDriver.Writer driver;
    private final ActiveViewGrants grants;
    private boolean scheduled;
    private boolean stopped;
    private Object inFlight;

    OutboundWriter(
            WebSocketSession session,
            DeliveryDriver driver,
            Delivery settings,
            BiConsumer<OutboundWriter, Exception> onFailure,
            ActiveViewGrants grants) {
        this.grants = grants;
        this.session = session;
        this.queue = new OutboundQueue(settings);
        this.onFailure = onFailure;
        this.driver = driver.writer(session, grants);
    }

    OutboundQueue.Admission enqueueProtected(List<OutboundQueue.Frame> batch) {
        discardSuperseded();
        var admitted = queue.offerProtected(batch);
        if (admitted == OutboundQueue.Admission.ACCEPTED) wake();
        return admitted;
    }

    OutboundQueue.Admission enqueueUpdate(long generation, OutboundQueue.Frame frame) {
        discardSuperseded();
        var admitted = queue.offerUpdate(generation, frame);
        if (admitted == OutboundQueue.Admission.ACCEPTED) wake();
        return admitted;
    }

    private void discardSuperseded() {
        if (grants != null) queue.discard(frame -> grants.superseded(frame.lease()));
    }

    void stop() {
        synchronized (this) {
            stopped = true;
            inFlight = null;
            queue.stop();
        }
        driver.stop();
    }

    private void wake() {
        synchronized (this) {
            if (stopped || scheduled || inFlight != null) return;
            scheduled = true;
        }
        try {
            driver.execute(this::step);
        } catch (RuntimeException failure) {
            fail(failure);
        }
    }

    private void step() {
        OutboundQueue.Frame frame;
        Object handoff;
        synchronized (this) {
            scheduled = false;
            if (stopped) return;
            frame = queue.poll();
            if (frame == null) return;
            handoff = new Object();
            inFlight = handoff;
        }
        try {
            if (!session.isOpen()) {
                stop();
                return;
            }
            driver.send(frame, failure -> complete(handoff, failure));
        } catch (RuntimeException failure) {
            complete(handoff, failure);
        }
    }

    private void complete(Object handoff, Exception failure) {
        synchronized (this) {
            if (stopped || inFlight != handoff) return;
            inFlight = null;
            if (failure != null) {
                stopped = true;
                queue.stop();
            }
        }
        if (failure == null) wake();
        else {
            driver.stop();
            onFailure.accept(this, failure);
        }
    }

    private void fail(Exception failure) {
        synchronized (this) {
            if (stopped) return;
            stopped = true;
            inFlight = null;
            queue.stop();
        }
        driver.stop();
        onFailure.accept(this, failure);
    }
}
