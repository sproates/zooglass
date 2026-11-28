package io.zooglass.runtime;

import io.zooglass.logging.OperationalLog;
import io.zooglass.logging.OperationalLog.SourceOperation;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;

/** A transport failure after processing does not change the result of applying the input. */
final class IngressReceipts {
    private final ObjectMapper json;
    private final OperationalLog log;
    private final SourceOperation operation;

    IngressReceipts(ObjectMapper json, OperationalLog log, SourceOperation operation) {
        this.json = json;
        this.log = log;
        this.operation = operation;
    }

    void invalid() {
        log.invalidInput(operation);
    }

    void processingFailed(RuntimeException failure) {
        if (!(failure instanceof StorageUnavailable)) {
            log.processingFailed(operation);
        }
    }

    void send(WebSocketSession session, Object outcome) throws IOException {
        TextMessage message;
        try {
            message = new TextMessage(json.writeValueAsString(outcome));
        } catch (RuntimeException failure) {
            log.receiptSerializationFailed(operation);
            throw failure;
        }
        try {
            session.sendMessage(message);
        } catch (IOException | RuntimeException failure) {
            log.receiptTransportFailed(operation);
            throw failure;
        }
    }
}
