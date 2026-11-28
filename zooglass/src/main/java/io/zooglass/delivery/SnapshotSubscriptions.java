package io.zooglass.delivery;

import io.zooglass.access.AccessDecision;
import io.zooglass.access.AdmissionAccess;
import io.zooglass.access.ViewResource;
import io.zooglass.access.ViewerHandshake;

import org.springframework.beans.factory.annotation.Autowired;
import io.zooglass.logging.OperationalLog;
import io.zooglass.logging.ViewerLog;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@io.zooglass.runtime.StandaloneDeployment
@Component
public class SnapshotSubscriptions extends TextWebSocketHandler {

    private final ViewerLog log;

    private final AdmissionAccess access;
    private final ObjectMapper objectMapper;
    private final SnapshotBroadcaster broadcaster;

    public SnapshotSubscriptions(ObjectMapper objectMapper, SnapshotBroadcaster broadcaster) {
        this(objectMapper, broadcaster, new AdmissionAccess());
    }

    public SnapshotSubscriptions(ObjectMapper objectMapper, SnapshotBroadcaster broadcaster, AdmissionAccess access) {
        this(objectMapper, broadcaster, access, ViewerLog.NONE);
    }

    @Autowired
    public SnapshotSubscriptions(ObjectMapper objectMapper, SnapshotBroadcaster broadcaster,
            AdmissionAccess access, OperationalLog operations) {
        this(objectMapper, broadcaster, access, operations.viewers());
    }

    SnapshotSubscriptions(ObjectMapper objectMapper, SnapshotBroadcaster broadcaster,
            AdmissionAccess access, ViewerLog log) {
        this.log = log;
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
        ViewerConnections.opened(log, session);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        JsonNode request;
        try {
            request = objectMapper.readTree(message.getPayload());
        } catch (JacksonException exception) {
            invalid(session);
            broadcaster.sendError(session, "Could not read live view request.");
            return;
        }

        try {
            if (request == null
                    || !request.isObject()
                    || !hasText(request, "action")
                    || !hasText(request, "viewId")
                    || !hasText(request, "entityId")) {
                invalid(session);
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
                    invalid(session);
                    broadcaster.sendError(
                            session, "Subscribe supports freshSnapshot without a cursor.");
                    return;
                }
                subscribe(session, new ViewResource(viewId, entityId));
            } else if (action.equals("unsubscribe")) {
                broadcaster.unsubscribe(session, viewId, entityId);
            } else {
                invalid(session);
                broadcaster.sendError(session, "Unknown action: " + action);
            }
        } catch (RuntimeException exception) {
            log.socket(ViewerLog.Event.REQUEST, ViewerConnections.reference(log, session));
            broadcaster.sendError(session, "Could not process live view request.");
        }
    }

    private void invalid(WebSocketSession session) {
        log.socket(ViewerLog.Event.INVALID, ViewerConnections.reference(log, session));
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
            access.recordRejection(ViewerLog.Boundary.SUBSCRIPTION, rejected.reason());
            return;
        }
        var grant = ((AccessDecision.Granted) decision).grant();
        if (!identity.subject().equals(grant.subject())) {
            broadcaster.closeAccess(session);
            return;
        }
        var result = broadcaster.subscribe(session, resource, grant);
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
        ViewerConnections.closed(log, session, status);
    }
}
