package io.zooglass.delivery;

import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.function.BiConsumer;

/** Owns one bounded queue and writer task. Failure callbacks acquire no writer lock. */
final class OutboundWriter {

    private static final int queueCapacity = 128;

    private final BiConsumer<OutboundWriter, IOException> onFailure;
    private final WebSocketSession session;
    private final ArrayBlockingQueue<TextMessage> messages =
            new ArrayBlockingQueue<>(queueCapacity);
    private final Future<?> task;

    OutboundWriter(
            WebSocketSession session,
            ExecutorService executor,
            BiConsumer<OutboundWriter, IOException> onFailure) {
        this.session = session;
        this.onFailure = onFailure;
        this.task = executor.submit(this::writeMessages);
    }

    boolean enqueue(List<TextMessage> batch) {
        // All producers hold the coordinator monitor. The writer can only free slots.
        if (messages.remainingCapacity() < batch.size()) {
            return false;
        }
        messages.addAll(batch);
        return true;
    }

    void stop() {
        task.cancel(true);
        messages.clear();
    }

    private void writeMessages() {
        try {
            while (session.isOpen()) {
                session.sendMessage(messages.take());
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        } catch (IOException exception) {
            onFailure.accept(this, exception);
        }
    }
}
