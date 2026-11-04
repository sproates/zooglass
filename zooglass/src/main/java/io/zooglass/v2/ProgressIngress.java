package io.zooglass.v2;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.List;

@Component
public final class ProgressIngress extends TextWebSocketHandler {
    private static final Logger LOG = LoggerFactory.getLogger(ProgressIngress.class);
    private final ViewCoordinator coordinator;
    private final ObjectMapper json;

    public ProgressIngress(ViewCoordinator coordinator, ObjectMapper json) {
        this.coordinator = coordinator;
        this.json = json;
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws IOException {
        ProgressControl control;
        try {
            control = ProgressControl.parse(message.getPayload());
        } catch (RuntimeException failure) {
            send(session, new ProgressOutcome("rejected", "invalidProgress", null, null, List.of()));
            return;
        }
        ProgressOutcome outcome;
        try {
            outcome = coordinator.advance(control);
        } catch (RuntimeException failure) {
            LOG.warn("V2 progress processing failed in session {} ({})", session.getId(), failure.getClass().getSimpleName());
            outcome = new ProgressOutcome("failed", "processingFailure", control, null, List.of());
        }
        send(session, outcome);
    }

    private void send(WebSocketSession session, ProgressOutcome outcome) throws IOException {
        session.sendMessage(new TextMessage(json.writeValueAsString(outcome)));
    }
}
