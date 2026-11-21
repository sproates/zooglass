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

    /** A missing decision describes unavailable detail, never proof that processing rolled back. */
    public record Result(PublicationOutcome outcome, PublicationDecision decision) {}

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message)
            throws IOException {
        handle(session, message, false);
    }

    /**
     * Opt-in diagnostics alongside the unchanged receipt sent through the ordinary ingress path.
     */
    public Result handleExplainedMessage(WebSocketSession session, TextMessage message)
            throws IOException {
        return handle(session, message, true);
    }

    private Result handle(WebSocketSession session, TextMessage message, boolean explained)
            throws IOException {
        Result result = process(session.getId(), message.getPayload(), explained);
        // Transport failure after application cannot undo state. A retry recovers the result.
        send(session, result.outcome());
        return result;
    }

    private Result process(String sessionId, String wire, boolean explained) {
        Publication event;
        try {
            event = PublicationJson.parse(wire);
        } catch (RuntimeException exception) {
            return new Result(PublicationOutcome.malformed(), null);
        }

        try {
            if (explained) {
                var result = coordinator.applyExplained(event);
                return new Result(result.outcome(), result.decision());
            }
            return new Result(coordinator.apply(event), null);
        } catch (RuntimeException exception) {
            // Do not label a strategy/storage failure as malformed source input or log payloads.
            LOG.warn(
                    "Publication processing failed in session {} ({})",
                    sessionId,
                    exception.getClass().getSimpleName());
            return new Result(
                    new PublicationOutcome(
                            "failed",
                            "processingFailure",
                            event.stream(),
                            event.publicationSequence(),
                            null,
                            List.of()),
                    null);
        }
    }

    private void send(WebSocketSession session, PublicationOutcome outcome) throws IOException {
        session.sendMessage(new TextMessage(json.writeValueAsString(outcome)));
    }
}
