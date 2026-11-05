package io.zooglass.runtime;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.List;

/** Parsing errors and processing failures have separate, payload-free outcomes. */
@Component
public final class EventIngress extends TextWebSocketHandler {

    private static final Logger LOG = LoggerFactory.getLogger(EventIngress.class);
    private final ViewCoordinator coordinator;
    private final ObjectMapper json;

    public EventIngress(ViewCoordinator coordinator, ObjectMapper json) {
        this.coordinator = coordinator;
        this.json = json;
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message)
            throws IOException {
        Publication event;
        try {
            event = PublicationJson.parse(message.getPayload());
        } catch (RuntimeException exception) {
            send(session, PublicationOutcome.malformed());
            return;
        }

        PublicationOutcome outcome;
        try {
            outcome = coordinator.apply(event);
        } catch (RuntimeException exception) {
            // Do not label a strategy/storage failure as malformed source input or log payloads.
            LOG.warn(
                    "Publication processing failed in session {} ({})",
                    session.getId(),
                    exception.getClass().getSimpleName());
            outcome =
                    new PublicationOutcome(
                            "failed",
                            "processingFailure",
                            event.stream(),
                            event.publicationSequence(),
                            null,
                            List.of());
        }
        // Transport failure after application cannot undo state. A retry recovers the result.
        send(session, outcome);
    }

    private void send(WebSocketSession session, PublicationOutcome outcome) throws IOException {
        session.sendMessage(new TextMessage(json.writeValueAsString(outcome)));
    }
}
