package io.zooglass.delivery;

import io.zooglass.access.AccessGrant;
import io.zooglass.access.ActiveViewGrants;
import io.zooglass.access.AdmissionAccess;
import io.zooglass.access.GrantRenewals;
import io.zooglass.access.ViewResource;
import io.zooglass.access.ViewerHandshake;
import io.zooglass.runtime.RuntimeConfiguration.Delivery;
import io.zooglass.runtime.ViewCoordinator;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.BooleanSupplier;
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
    private final ActiveViewGrants grants;
    private final GrantRenewals renewals;
    private final DeliveryDriver driver;
    private final SubscriptionIndex subscriptions = new SubscriptionIndex();
    private final Map<WebSocketSession, OutboundWriter> writersBySession = new LinkedHashMap<>();
    private boolean closed;

    public SnapshotBroadcaster(ObjectMapper objectMapper, ViewCoordinator coordinator) {
        this(objectMapper, coordinator, new AdmissionAccess());
    }

    @Autowired
    public SnapshotBroadcaster(
            ObjectMapper objectMapper, ViewCoordinator coordinator, AdmissionAccess access) {
        this(objectMapper, coordinator, access, new SocketDeliveryDriver());
    }

    SnapshotBroadcaster(
            ObjectMapper objectMapper,
            ViewCoordinator coordinator,
            AdmissionAccess access,
            DeliveryDriver driver) {
        this.driver = driver;
        this.grants =
                access.protectedMode()
                        ? new ActiveViewGrants(access, this::requestAccessClose)
                        : null;
        this.objectMapper = objectMapper;
        this.coordinator = coordinator;
        this.settings = coordinator.delivery();
        this.detach = coordinator.listen(subscriptions::hasRecipients, this::sendUpdate);
        this.renewals = grants == null ? null : new GrantRenewals(grants);
    }

    public void registerSession(WebSocketSession session) {
        synchronized (coordinator) {
            if (closed) throw new IllegalStateException("Delivery is closed");
            if (grants != null) {
                var identity =
                        (ViewerHandshake.Identity)
                                session.getAttributes().get(ViewerHandshake.IDENTITY);
                grants.register(session, identity);
            }
            writersBySession.computeIfAbsent(
                    session,
                    ignored ->
                            new OutboundWriter(
                                    session,
                                    driver,
                                    settings,
                                    (writer, failure) ->
                                            handleWriteFailure(session, writer, failure),
                                    grants));
        }
    }

    public enum Admission {
        ADMITTED,
        UNKNOWN_VIEW,
        REFUSED,
        FAILED
    }

    public boolean subscribe(WebSocketSession session, String viewId, String entityId) {
        return subscribe(session, viewId, entityId, () -> true) != Admission.UNKNOWN_VIEW;
    }

    public Admission subscribe(
            WebSocketSession session, String viewId, String entityId, BooleanSupplier permitted) {
        return subscribe(session, viewId, entityId, permitted, null);
    }

    public Admission subscribe(WebSocketSession session, ViewResource resource, AccessGrant grant) {
        return subscribe(
                session,
                resource.viewId(),
                resource.entityId(),
                () -> grant.permits(resource),
                grant);
    }

    private Admission subscribe(
            WebSocketSession session,
            String viewId,
            String entityId,
            BooleanSupplier permitted,
            AccessGrant grant) {
        synchronized (coordinator) {
            if (!permitted.getAsBoolean()) {
                return Admission.REFUSED;
            }
            var snapshot = coordinator.snapshot(viewId, entityId);
            if (snapshot.isEmpty()) {
                return permitted.getAsBoolean() ? Admission.UNKNOWN_VIEW : Admission.REFUSED;
            }
            List<OutboundQueue.Frame> opening;
            try {
                opening =
                        settings.recovery().openingMessages(snapshot.orElseThrow()).stream()
                                .map(this::frame)
                                .toList();
            } catch (RuntimeException failure) {
                logger.warn(
                        "Could not prepare subscription opening for client {}", session.getId());
                removeSession(session);
                return Admission.FAILED;
            }
            // Preparation may take time. Admit the ack and baseline only under a current grant.
            if (!permitted.getAsBoolean()) {
                return Admission.REFUSED;
            }
            if (grants != null
                    && (grant == null
                            || !grants.admit(session, new ViewResource(viewId, entityId), grant))) {
                return Admission.REFUSED;
            }
            subscriptions.add(session, viewId, entityId);
            var admitted = scoped(session, new ViewResource(viewId, entityId), opening);
            enqueue(session, writer -> writer.enqueueProtected(admitted));
            return Admission.ADMITTED;
        }
    }

    public void refuseSubscription(
            WebSocketSession session, String viewId, String entityId, String code) {
        if (grants != null && grants.refuse(session, new ViewResource(viewId, entityId))) {
            return;
        }
        synchronized (coordinator) {
            if (subscriptions.recipients(viewId, entityId).containsKey(session)) {
                closeAccess(session);
            } else {
                send(session, new AccessError("error", code));
            }
        }
    }

    private void requestAccessClose(WebSocketSession session) {
        // Grants are already invalidated. Never make expiry scans or policy workers
        // wait for coordinator work while removing delivery state.
        try {
            driver.execute(() -> closeAccess(session));
        } catch (RejectedExecutionException stopped) {
            // Shutdown has removed memberships and stopped writers already.
            requestClose(session, CloseStatus.POLICY_VIOLATION);
        }
    }

    public void closeAccess(WebSocketSession session) {
        if (grants != null) {
            grants.remove(session);
        }
        synchronized (coordinator) {
            removeSession(session);
            requestClose(session, CloseStatus.POLICY_VIOLATION);
        }
    }

    private record AccessError(String type, String code) {}

    public void unsubscribe(WebSocketSession session, String viewId, String entityId) {
        if (grants != null) {
            grants.remove(session, new ViewResource(viewId, entityId));
        }
        synchronized (coordinator) {
            subscriptions.remove(session, viewId, entityId);
            send(session, new SubscriptionResponse("unsubscribed", viewId, entityId));
        }
    }

    public void removeSession(WebSocketSession session) {
        if (grants != null) {
            grants.remove(session);
        }
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
                        enqueue(
                                session,
                                writer ->
                                        writer.enqueueUpdate(
                                                generation,
                                                scoped(
                                                                session,
                                                                new ViewResource(
                                                                        snapshot.viewId(),
                                                                        snapshot.entityId()),
                                                                List.of(shared))
                                                        .getFirst())));
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
                writer ->
                        writer.enqueueProtected(
                                scoped(
                                        session,
                                        null,
                                        messages.stream().map(this::frame).toList())));
    }

    private List<OutboundQueue.Frame> scoped(
            WebSocketSession session, ViewResource resource, List<OutboundQueue.Frame> frames) {
        if (grants == null) {
            return frames;
        }
        var lease = grants.capture(session, resource);
        return frames.stream().map(frame -> frame.forLease(lease)).toList();
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

    private void requestClose(WebSocketSession session, CloseStatus status) {
        driver.closeSession(session, status);
    }

    @Override
    public void close() {
        synchronized (coordinator) {
            if (closed) return;
            closed = true;
            if (renewals != null) {
                renewals.close();
            }
            for (OutboundWriter writer : writersBySession.values()) {
                writer.stop();
            }
            writersBySession.clear();
            subscriptions.clear();
            detach.run();
            driver.close();
        }
    }

    private record SubscriptionResponse(String type, String viewId, String entityId) {}

    private record ClientError(String type, String message) {}
}
