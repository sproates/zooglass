package io.zooglass;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class EventLoggingWebSocketHandler extends TextWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(EventLoggingWebSocketHandler.class);
    private final ObjectMapper objectMapper;
    private final LiveViewBroadcaster liveViewBroadcaster;

    public EventLoggingWebSocketHandler(ObjectMapper objectMapper, LiveViewBroadcaster liveViewBroadcaster) {
        this.objectMapper = objectMapper;
        this.liveViewBroadcaster = liveViewBroadcaster;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        logger.info("WebSocket client connected: {}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        logger.info("Received event from client {}: {}", session.getId(), message.getPayload());
        try {
            JsonNode event = objectMapper.readTree(message.getPayload());
            if (event == null || !event.isObject()
                    || !hasText(event, "sourceId")
                    || !hasText(event, "type")
                    || !hasText(event, "entityId")
                    || !event.path("payload").isObject()) {
                logger.warn("Ignoring invalid event from client {}", session.getId());
                return;
            }

            liveViewBroadcaster.apply(
                    event.get("sourceId").stringValue(),
                    event.get("type").stringValue(),
                    event.get("entityId").stringValue(),
                    event.get("payload"));
        } catch (Exception exception) {
            logger.warn("Ignoring invalid event from client {}: {}", session.getId(), exception.getMessage());
        }
    }

    private static boolean hasText(JsonNode event, String field) {
        return event.path(field).isTextual() && !event.path(field).stringValue().isBlank();
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        logger.info("WebSocket client disconnected: {}", session.getId());
    }
}
