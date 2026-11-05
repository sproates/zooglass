package io.zooglass.delivery;

import io.zooglass.runtime.RuntimeConfiguration.Delivery;

import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.function.BiConsumer;

/** Owns one bounded queue and writer task. Failure callbacks acquire no writer lock. */
final class OutboundWriter {

    private final BiConsumer<OutboundWriter, IOException> onFailure;
    private final WebSocketSession session;
    private final OutboundQueue queue;
    private final Future<?> task;

    OutboundWriter(
            WebSocketSession session,
            ExecutorService executor,
            Delivery settings,
            BiConsumer<OutboundWriter, IOException> onFailure) {
        this.session = session;
        this.queue = new OutboundQueue(settings);
        this.onFailure = onFailure;
        this.task = executor.submit(this::writeMessages);
    }

    OutboundQueue.Admission enqueueProtected(List<TextMessage> batch) {
        return queue.offerProtected(batch);
    }

    OutboundQueue.Admission enqueueUpdate(long generation, TextMessage message) {
        return queue.offerUpdate(generation, message);
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
                session.sendMessage(frame);
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        } catch (IOException exception) {
            onFailure.accept(this, exception);
        }
    }
}
