package io.zooglass.runtime;

import io.zooglass.logging.OperationalLog;
import io.zooglass.logging.OperationalLog.SourceOperation;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.List;

@io.zooglass.runtime.StandaloneDeployment
@Component
public final class ProgressIngress extends TextWebSocketHandler {

    private final ViewCoordinator coordinator;
    private final IngressReceipts receipts;

    public ProgressIngress(ViewCoordinator coordinator, ObjectMapper json) {
        this(coordinator, json, OperationalLog.NONE);
    }

    @Autowired
    public ProgressIngress(ViewCoordinator coordinator, ObjectMapper json, OperationalLog operations) {
        this.coordinator = coordinator;
        this.receipts = new IngressReceipts(json, operations, SourceOperation.PROGRESS);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message)
            throws IOException {
        ProgressControl control;
        try {
            control = ProgressControl.parse(message.getPayload());
        } catch (RuntimeException failure) {
            receipts.invalid();
            receipts.send(
                    session,
                    new ProgressOutcome("rejected", "invalidProgress", null, null, List.of()));
            return;
        }
        ProgressOutcome outcome;
        try {
            outcome = coordinator.advance(control);
        } catch (RuntimeException failure) {
            receipts.processingFailed(failure);
            outcome = new ProgressOutcome("failed", "processingFailure", control, null, List.of());
        }
        receipts.send(session, outcome);
    }
}
