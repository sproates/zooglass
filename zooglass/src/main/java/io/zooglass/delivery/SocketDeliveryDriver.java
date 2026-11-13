package io.zooglass.delivery;

import io.zooglass.access.ActiveViewGrants;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/** Native execution of the same writer turns used by controlled delivery. */
final class SocketDeliveryDriver implements DeliveryDriver {
    private static final Logger logger = LoggerFactory.getLogger(SocketDeliveryDriver.class);
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

    public Writer writer(WebSocketSession session, ActiveViewGrants grants) {
        return new SocketWriter(session, grants);
    }

    public void execute(Runnable action) {
        executor.execute(action);
    }

    public void closeSession(WebSocketSession session, CloseStatus status) {
        // Close must remain possible after executor shutdown and must never block a coordinator.
        Thread.startVirtualThread(
                () -> {
                    try {
                        if (session.isOpen()) session.close(status);
                    } catch (IOException | RuntimeException failure) {
                        logger.warn(
                                "Could not close live view client {}: {}",
                                session.getId(),
                                failure.getMessage());
                    }
                });
    }

    public void close() {
        executor.shutdownNow();
    }

    private final class SocketWriter implements Writer {
        private final WebSocketSession session;
        private final AuthorisedSocketTransport protectedTransport;
        private final Set<Thread> running = new HashSet<>();
        private boolean stopped;

        SocketWriter(WebSocketSession session, ActiveViewGrants grants) {
            this.session = session;
            protectedTransport =
                    grants == null ? null : new AuthorisedSocketTransport(session, grants);
        }

        public void execute(Runnable turn) {
            executor.execute(
                    () -> {
                        var thread = Thread.currentThread();
                        synchronized (this) {
                            if (stopped) return;
                            running.add(thread);
                        }
                        try {
                            turn.run();
                        } finally {
                            synchronized (this) {
                                running.remove(thread);
                            }
                        }
                    });
        }

        public void send(OutboundQueue.Frame frame, Consumer<Exception> completed) {
            synchronized (this) {
                if (stopped) return;
            }
            Exception failure = null;
            try {
                if (protectedTransport == null) session.sendMessage(frame.message());
                else protectedTransport.send(frame);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                failure = interrupted;
            } catch (IOException | RuntimeException exception) {
                failure = exception;
            }
            completed.accept(failure);
        }

        public synchronized void stop() {
            stopped = true;
            running.forEach(Thread::interrupt);
        }
    }
}
