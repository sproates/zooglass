package io.zooglass.delivery;

import io.zooglass.runtime.RuntimeConfiguration.Delivery;
import io.zooglass.runtime.ViewCoordinator;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;

/** Enqueues committed snapshots and subscription replies under the coordinator monitor. */
@Component
public class SnapshotBroadcaster implements AutoCloseable {

    private static final Logger logger = LoggerFactory.getLogger(SnapshotBroadcaster.class);
    private static final CloseStatus slowClientCloseStatus =
            new CloseStatus(1013, "Live view client is too slow");

    private final ObjectMapper objectMapper;
    private final ViewCoordinator coordinator;
    private final Delivery settings;
    private final Runnable detach;
    private final ExecutorService outboundExecutor = Executors.newVirtualThreadPerTaskExecutor();
    private final SubscriptionIndex subscriptions = new SubscriptionIndex();
    private final Map<WebSocketSession, OutboundWriter> writersBySession = new HashMap<>();

    public SnapshotBroadcaster(ObjectMapper objectMapper, ViewCoordinator coordinator) {
        this.objectMapper = objectMapper;
        this.coordinator = coordinator;
        this.settings = coordinator.delivery();
        this.detach = coordinator.listen(subscriptions::hasRecipients, this::sendUpdate);
    }

    public void registerSession(WebSocketSession session) {
        synchronized (coordinator) {
            writersBySession.computeIfAbsent(
                    session,
                    ignored ->
                            new OutboundWriter(
                                    session,
                                    outboundExecutor,
                                    settings,
                                    (writer, failure) ->
                                            handleWriteFailure(session, writer, failure)));
        }
    }

    public boolean subscribe(WebSocketSession session, String viewId, String entityId) {
        synchronized (coordinator) {
            var snapshot = coordinator.snapshot(viewId, entityId);
            if (snapshot.isEmpty()) {
                return false;
            }

            var opening = settings.recovery().openingMessages(snapshot.orElseThrow());
            subscriptions.add(session, viewId, entityId);
            sendProtected(session, opening);
            return true;
        }
    }

    public void unsubscribe(WebSocketSession session, String viewId, String entityId) {
        synchronized (coordinator) {
            subscriptions.remove(session, viewId, entityId);
            send(session, new SubscriptionResponse("unsubscribed", viewId, entityId));
        }
    }

    public void removeSession(WebSocketSession session) {
        synchronized (coordinator) {
            OutboundWriter writer = writersBySession.remove(session);
            if (writer != null) {
                writer.stop();
            }

            subscriptions.removeSession(session);
        }
    }

    public void sendError(WebSocketSession session, String message) {
        synchronized (coordinator) {
            send(session, new ClientError("error", message));
        }
    }

    private void sendUpdate(ViewCoordinator.Snapshot snapshot) {
        var recipients = subscriptions.recipients(snapshot.viewId(), snapshot.entityId());
        OutboundQueue.Frame shared;
        try {
            shared = frame(ViewUpdate.from(snapshot));
        } catch (RuntimeException exception) {
            logger.warn(
                    "Could not prepare live view update for {}: {}",
                    snapshot.viewId(),
                    exception.getMessage());
            for (var session : recipients.keySet()) {
                removeSession(session);
                requestClose(session, CloseStatus.SERVER_ERROR);
            }
            return;
        }
        recipients.forEach(
                (session, generation) ->
                        enqueue(session, writer -> writer.enqueueUpdate(generation, shared)));
    }

    private void send(WebSocketSession session, Object message) {
        sendProtected(session, List.of(message));
    }

    private OutboundQueue.Frame frame(Object message) {
        return new OutboundQueue.Frame(objectMapper.writeValueAsString(message));
    }

    private void sendProtected(WebSocketSession session, List<Object> messages) {
        enqueue(
                session,
                writer -> writer.enqueueProtected(messages.stream().map(this::frame).toList()));
    }

    private void enqueue(
            WebSocketSession session, Function<OutboundWriter, OutboundQueue.Admission> offer) {
        OutboundWriter writer = writersBySession.get(session);
        if (writer == null || !session.isOpen()) {
            removeSession(session);
            return;
        }

        try {
            var admission = offer.apply(writer);
            if (admission != OutboundQueue.Admission.ACCEPTED) {
                logger.warn("Closing live view client {}: {}", session.getId(), admission);
                removeSession(session);
                requestClose(
                        session,
                        admission == OutboundQueue.Admission.TOO_LARGE
                                ? CloseStatus.TOO_BIG_TO_PROCESS
                                : slowClientCloseStatus);
            }
        } catch (Exception exception) {
            logger.warn(
                    "Could not queue a live view message for client {}: {}",
                    session.getId(),
                    exception.getMessage());
            removeSession(session);
        }
    }

    private void handleWriteFailure(
            WebSocketSession session, OutboundWriter writer, Exception exception) {
        synchronized (coordinator) {
            if (writersBySession.get(session) != writer) {
                return;
            }

            logger.warn(
                    "Could not send a live view message to client {}: {}",
                    session.getId(),
                    exception.getMessage());
            removeSession(session);
            requestClose(session, slowClientCloseStatus);
        }
    }

    private static void requestClose(WebSocketSession session, CloseStatus status) {
        Thread.startVirtualThread(
                () -> {
                    try {
                        if (session.isOpen()) {
                            session.close(status);
                        }
                    } catch (IOException | RuntimeException exception) {
                        logger.warn(
                                "Could not close slow live view client {}: {}",
                                session.getId(),
                                exception.getMessage());
                    }
                });
    }

    @Override
    public void close() {
        synchronized (coordinator) {
            for (OutboundWriter writer : writersBySession.values()) {
                writer.stop();
            }
            writersBySession.clear();
            subscriptions.clear();
            detach.run();
            outboundExecutor.shutdownNow();
        }
    }

    private record SubscriptionResponse(String type, String viewId, String entityId) {}

    private record ClientError(String type, String message) {}
}
