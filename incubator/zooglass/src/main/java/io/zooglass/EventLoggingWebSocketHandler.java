package io.zooglass;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class EventLoggingWebSocketHandler extends TextWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(EventLoggingWebSocketHandler.class);

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        logger.info("Received event from client {}: {}", session.getId(), message.getPayload());
    }
}
