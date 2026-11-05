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
import java.util.Map;

@Component
public final class FactRetirementIngress extends TextWebSocketHandler {

    private static final Logger LOG = LoggerFactory.getLogger(FactRetirementIngress.class);
    private final ViewCoordinator coordinator;
    private final ObjectMapper json;

    public FactRetirementIngress(ViewCoordinator coordinator, ObjectMapper json) {
        this.coordinator = coordinator;
        this.json = json;
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message)
            throws IOException {
        FactRetirement control;
        try {
            control = FactRetirement.parse(message.getPayload());
        } catch (RuntimeException failure) {
            send(session, FactRetirementOutcome.rejected(null, null, "invalidFactRetirement"));
            return;
        }
        FactRetirementOutcome outcome;
        try {
            outcome = coordinator.retire(control);
        } catch (RuntimeException failure) {
            LOG.warn(
                    "V2 retirement failed in session {} ({})",
                    session.getId(),
                    failure.getClass().getSimpleName());
            outcome =
                    new FactRetirementOutcome(
                            "factRetirement",
                            "failed",
                            "processingFailure",
                            control,
                            null,
                            Map.of(),
                            List.of());
        }
        send(session, outcome);
    }

    private void send(WebSocketSession session, FactRetirementOutcome outcome) throws IOException {
        session.sendMessage(new TextMessage(json.writeValueAsString(outcome)));
    }
}
