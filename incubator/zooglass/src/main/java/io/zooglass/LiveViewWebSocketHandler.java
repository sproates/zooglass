package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class LiveViewWebSocketHandler extends TextWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(LiveViewWebSocketHandler.class);

    private final ObjectMapper objectMapper;
    private final LiveViewBroadcaster broadcaster;

    public LiveViewWebSocketHandler(ObjectMapper objectMapper, LiveViewBroadcaster broadcaster) {
        this.objectMapper = objectMapper;
        this.broadcaster = broadcaster;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        logger.info("WebSocket client connected: {}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        try {
            JsonNode request = objectMapper.readTree(message.getPayload());
            if (request == null || !request.isObject()
                    || !hasText(request, "action")
                    || !hasText(request, "viewId")
                    || !hasText(request, "entityId")) {
                broadcaster.sendError(session, "Expected action, viewId, and entityId text fields.");
                return;
            }

            String action = request.get("action").stringValue();
            String viewId = request.get("viewId").stringValue();
            String entityId = request.get("entityId").stringValue();
            if (action.equals("subscribe")) {
                if (!broadcaster.subscribe(session, viewId, entityId)) {
                    broadcaster.sendError(session, "Unknown view: " + viewId);
                }
            } else if (action.equals("unsubscribe")) {
                broadcaster.unsubscribe(session, viewId, entityId);
            } else {
                broadcaster.sendError(session, "Unknown action: " + action);
            }
        } catch (Exception exception) {
            logger.warn("Ignoring invalid live view request from client {}: {}", session.getId(), exception.getMessage());
            broadcaster.sendError(session, "Could not read live view request.");
        }
    }

    private static boolean hasText(JsonNode request, String field) {
        return request.path(field).isTextual() && !request.path(field).stringValue().isBlank();
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        broadcaster.removeSession(session);
        logger.info("WebSocket client disconnected: {}", session.getId());
    }
}
