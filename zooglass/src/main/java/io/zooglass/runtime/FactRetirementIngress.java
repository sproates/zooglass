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
import java.util.Map;

@Component
public final class FactRetirementIngress extends TextWebSocketHandler {

    private final ViewCoordinator coordinator;
    private final IngressReceipts receipts;

    public FactRetirementIngress(ViewCoordinator coordinator, ObjectMapper json) {
        this(coordinator, json, OperationalLog.NONE);
    }

    @Autowired
    public FactRetirementIngress(ViewCoordinator coordinator, ObjectMapper json, OperationalLog operations) {
        this.coordinator = coordinator;
        this.receipts = new IngressReceipts(json, operations, SourceOperation.RETIREMENT);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message)
            throws IOException {
        FactRetirement control;
        try {
            control = FactRetirement.parse(message.getPayload());
        } catch (RuntimeException failure) {
            receipts.invalid();
            receipts.send(session, FactRetirementOutcome.rejected(null, null, "invalidFactRetirement"));
            return;
        }
        FactRetirementOutcome outcome;
        try {
            outcome = coordinator.retire(control);
        } catch (RuntimeException failure) {
            receipts.processingFailed(failure);
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
        receipts.send(session, outcome);
    }
}
