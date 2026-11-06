package io.zooglass.delivery;

import io.zooglass.access.AccessDecision;
import io.zooglass.access.AdmissionAccess;
import io.zooglass.access.ViewResource;
import io.zooglass.access.ViewerHandshake;

import org.springframework.beans.factory.annotation.Autowired;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Component
public class SnapshotSubscriptions extends TextWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(SnapshotSubscriptions.class);

    private final AdmissionAccess access;
    private final ObjectMapper objectMapper;
    private final SnapshotBroadcaster broadcaster;

    public SnapshotSubscriptions(ObjectMapper objectMapper, SnapshotBroadcaster broadcaster) {
        this(objectMapper, broadcaster, new AdmissionAccess());
    }

    @Autowired
    public SnapshotSubscriptions(ObjectMapper objectMapper, SnapshotBroadcaster broadcaster,
            AdmissionAccess access) {
        this.access = access;
        this.objectMapper = objectMapper;
        this.broadcaster = broadcaster;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        if (access.protectedMode()
                && !(session.getAttributes().get(ViewerHandshake.IDENTITY) instanceof ViewerHandshake.Identity)) {
            broadcaster.closeAccess(session);
            return;
        }
        broadcaster.registerSession(session);
        logger.info("WebSocket client connected: {}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        JsonNode request;
        try {
            request = objectMapper.readTree(message.getPayload());
        } catch (JacksonException exception) {
            logger.warn(
                    "Ignoring invalid live view request from client {}", session.getId());
            broadcaster.sendError(session, "Could not read live view request.");
            return;
        }

        try {
            if (request == null
                    || !request.isObject()
                    || !hasText(request, "action")
                    || !hasText(request, "viewId")
                    || !hasText(request, "entityId")) {
                broadcaster.sendError(
                        session, "Expected action, viewId, and entityId text fields.");
                return;
            }

            String action = request.get("action").stringValue();
            String viewId = request.get("viewId").stringValue();
            String entityId = request.get("entityId").stringValue();
            if (action.equals("subscribe")) {
                if (request.has("cursor")
                        || (request.has("recovery")
                                && !FreshSnapshot.MODE.equals(request.path("recovery").asText()))) {
                    broadcaster.sendError(
                            session, "Subscribe supports freshSnapshot without a cursor.");
                    return;
                }
                subscribe(session, new ViewResource(viewId, entityId));
            } else if (action.equals("unsubscribe")) {
                broadcaster.unsubscribe(session, viewId, entityId);
            } else {
                broadcaster.sendError(session, "Unknown action: " + action);
            }
        } catch (RuntimeException exception) {
            logger.error(
                    "Could not process live view request from client {}",
                    session.getId(),
                    exception);
            broadcaster.sendError(session, "Could not process live view request.");
        }
    }

    private void subscribe(WebSocketSession session, ViewResource resource) {
        if (!access.protectedMode()) {
            if (!broadcaster.subscribe(session, resource.viewId(), resource.entityId())) {
                broadcaster.sendError(session, "Unknown view: " + resource.viewId());
            }
            return;
        }
        var attribute = session.getAttributes().get(ViewerHandshake.IDENTITY);
        if (!(attribute instanceof ViewerHandshake.Identity identity)) {
            broadcaster.closeAccess(session);
            return;
        }
        // Policy I/O happens before entering the broadcaster/coordinator monitor.
        var decision = access.authorise(identity.credential(), resource);
        if (decision instanceof AccessDecision.Rejected rejected) {
            String code = rejected.reason() == AccessDecision.Reason.UNAVAILABLE
                    ? "accessUnavailable" : "accessDenied";
            broadcaster.refuseSubscription(session, resource.viewId(), resource.entityId(), code);
            return;
        }
        var grant = ((AccessDecision.Granted) decision).grant();
        if (!identity.subject().equals(grant.subject())) {
            broadcaster.closeAccess(session);
            return;
        }
        var result = broadcaster.subscribe(session, resource.viewId(), resource.entityId(),
                () -> grant.permits(resource));
        if (result == SnapshotBroadcaster.Admission.REFUSED) {
            broadcaster.refuseSubscription(session, resource.viewId(), resource.entityId(), "accessUnavailable");
        } else if (result == SnapshotBroadcaster.Admission.FAILED) {
            broadcaster.closeAccess(session);
        } else if (result == SnapshotBroadcaster.Admission.UNKNOWN_VIEW) {
            broadcaster.sendError(session, "Unknown view");
        }
    }

    private static boolean hasText(JsonNode request, String field) {
        return request.path(field).isTextual() && !request.path(field).stringValue().isBlank();
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        broadcaster.removeSession(session);
        if (access.protectedMode()) {
            session.getAttributes().remove(ViewerHandshake.IDENTITY);
        }
        logger.info("WebSocket client disconnected: {}", session.getId());
    }
}
