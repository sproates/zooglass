package io.zooglass.runtime;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.PatternLayout;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.zooglass.access.AdmissionAccess;
import io.zooglass.logging.OperationalLog;
import io.zooglass.logging.ViewerLogCapture;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import static io.zooglass.logging.OperationalLog.SourceOperation.PUBLICATION;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.AdditionalAnswers.delegatesTo;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class OperationalBoundaryTests {
    private static final String SENTINEL = "private\nheader-and-value";
    private static final String ENVELOPE = """
            {"sourceId":"fleet","epoch":"trip-1","sourceEntityId":"car",
             "publicationSequence":1,"type":"position","payload":{"value":1}}
            """;
    private final JsonMapper json = new JsonMapper();
    @TempDir Path temporary;

    @Test
    void failedSnapshotListenerIsReportedWithoutUndoingTheInstalledPublication() throws Exception {
        try (var capture = new ViewerLogCapture();
                var runtime = new ViewCoordinator(IdentityFixtures.configuration(2, 10, 3), "",
                        ReceiptClock.SYSTEM, null, SystemAlarmScheduler::new, capture.operations)) {
            runtime.listen(snapshot -> { throw new IllegalStateException("SENTINEL-listener"); });
            runtime.apply(IdentityFixtures.event(1));
            assertThat(runtime.snapshot("arrival", "car").orElseThrow().version()).isEqualTo(1);
            assertThat(capture.next("delivery.failed")).containsEntry("stage", "listener")
                    .containsEntry("reason", "listenerFailed").doesNotContainKey("connectionRef");
        }
    }

    @Test
    void lostReceiptIsLoggedAtSendAndRetryRemainsADuplicate() throws Exception {
        var log = mock(OperationalLog.class);
        try (var runtime = new ViewCoordinator(IdentityFixtures.configuration(2, 10, 3))) {
            var ingress = new EventIngress(runtime, json, log);
            var lost = mock(WebSocketSession.class);
            var failure = new IOException(SENTINEL);
            doThrow(failure).when(lost).sendMessage(any());
            assertThatThrownBy(() -> ingress.handleTextMessage(lost, new TextMessage(ENVELOPE))).isSameAs(failure);
            verify(log).receiptTransportFailed(PUBLICATION);
            var snapshot = runtime.snapshot("arrival", "car");
            var delivered = new ArrayList<String>();
            ingress.handleTextMessage(capturing(delivered), new TextMessage(ENVELOPE));
            assertThat(json.readTree(delivered.getFirst()).path("status").asText()).isEqualTo("duplicate");
            assertThat(runtime.snapshot("arrival", "car")).isEqualTo(snapshot);
            verifyNoMoreInteractions(log);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"publication", "progress", "factRetirement"})
    void sourceFailureRecordsWithholdSessionPayloadAndNestedExceptions(String operation) throws Exception {
        var runtime = mock(ViewCoordinator.class);
        var injected = new IllegalStateException("private-exception", new IOException("private-cause"));
        var log = OperationalLog.forService();
        WebSocketHandler handler;
        String input;
        String invalid;
        switch (operation) {
            case "publication" -> {
                when(runtime.apply(any())).thenThrow(injected);
                handler = new EventIngress(runtime, json, log);
                input = ENVELOPE.replace("car", "private-entity");
                invalid = "invalidEnvelope";
            }
            case "progress" -> {
                when(runtime.advance(any())).thenThrow(injected);
                handler = new ProgressIngress(runtime, json, log);
                input = """
                        {"sourceId":"fleet","epoch":"v1","sourceEntityId":"private-entity","throughSequence":42}
                        """;
                invalid = "invalidProgress";
            }
            case "factRetirement" -> {
                when(runtime.retire(any())).thenThrow(injected);
                handler = new FactRetirementIngress(runtime, json, log);
                input = json.writeValueAsString(new FactRetirement("private-view", "private-entity", List.of("value"), 2));
                invalid = "invalidFactRetirement";
            }
            default -> throw new AssertionError(operation);
        }
        var socket = mock(WebSocketSession.class);
        when(socket.getId()).thenReturn("private-session\r\nprivate-header");
        var logger = (Logger) LoggerFactory.getLogger("io.zooglass.operations");
        // Include the former emitting class so the old unstructured warning cannot pass unnoticed.
        var legacy = (Logger) LoggerFactory.getLogger(handler.getClass());
        var capture = new ListAppender<ILoggingEvent>();
        var layout = new PatternLayout();
        layout.setContext(logger.getLoggerContext());
        layout.setPattern("%level %msg %kvp%n%ex");
        layout.start();
        var oldLevel = logger.getLevel();
        logger.setLevel(Level.DEBUG);
        capture.start();
        logger.addAppender(capture);
        legacy.addAppender(capture);
        try {
            handler.handleMessage(socket, new TextMessage("{private-malformed"));
            doThrow(new IOException("private-transport", injected)).when(socket).sendMessage(any());
            assertThatThrownBy(() -> handler.handleMessage(socket, new TextMessage(input)))
                    .isInstanceOf(IOException.class);
            assertThat(capture.list).extracting(ILoggingEvent::getLevel)
                    .containsExactly(Level.DEBUG, Level.ERROR, Level.WARN);
            var rendered = capture.list.stream().map(layout::doLayout).toList();
            assertThat(rendered.get(0)).contains("request.invalid", invalid, operation);
            assertThat(rendered.get(1)).contains("processing.failed", "unexpected", operation);
            assertThat(rendered.get(2)).contains("receipt.send_failed", "transport", operation);
            assertThat(rendered).allSatisfy(line -> assertThat(line).doesNotContain("private-"));
            assertThat(capture.list).allSatisfy(event -> {
                assertThat(event.getThrowableProxy()).isNull();
                assertThat(event.getKeyValuePairs()).extracting(pair -> pair.key)
                        .containsExactlyInAnyOrder("event", "reason", "operation", "instanceId");
            });
        } finally {
            logger.detachAppender(capture);
            legacy.detachAppender(capture);
            logger.setLevel(oldLevel);
            capture.stop();
            layout.stop();
        }
    }

    @Test
    void sqliteTransitionOwnsTheOnlyDiagnosticAndHealthRemainsDown() throws Exception {
        var config = SqliteRecoveryTests.configuration();
        var file = temporary.resolve("store.sqlite");
        try (var initial = new ViewCoordinator(config, file.toString())) {
            initial.apply(IdentityFixtures.event(1));
        }
        try (var db = DriverManager.getConnection("jdbc:sqlite:" + file.toUri());
             var statement = db.createStatement()) {
            statement.execute("CREATE TRIGGER refuse BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT, 'secret'); END");
        }
        var log = mock(OperationalLog.class);
        try (var runtime = new ViewCoordinator(config, file.toString(), ReceiptClock.SYSTEM, null, SystemAlarmScheduler::new, log)) {
            var ingress = new EventIngress(runtime, json, log);
            var received = new ArrayList<String>();
            var socket = capturing(received);
            var next = new TextMessage(ENVELOPE.replace("\"publicationSequence\":1", "\"publicationSequence\":2"));
            ingress.handleTextMessage(socket, next);
            ingress.handleTextMessage(socket, next);
            assertThat(received).hasSize(2);
            for (String receipt : received) {
                assertThat(json.readTree(receipt).path("reason").asText()).isEqualTo("processingFailure");
            }
            assertThat(new StorageHealth(runtime).health().getStatus().getCode()).isEqualTo("DOWN");
            verify(log).storageLost(OperationalLog.StoreOperation.INSTALL);
            verifyNoMoreInteractions(log);
        }
    }

    @Test
    void storeCloseFailurePropagatesAndReportsOutsideTheCoordinatorMonitor() throws Exception {
        var file = temporary.resolve("close.sqlite").toString();
        var log = mock(OperationalLog.class);
        try (var real = SqliteConnection.open(file); var opening = mockStatic(SqliteConnection.class)) {
            var database = mock(Connection.class, delegatesTo(real));
            opening.when(() -> SqliteConnection.open(file)).thenReturn(database);
            opening.when(() -> SqliteConnection.configure(database)).thenCallRealMethod();
            var runtime = new ViewCoordinator(SqliteRecoveryTests.configuration(), file, ReceiptClock.SYSTEM,
                    null, SystemAlarmScheduler::new, log);
            var injected = new SQLException(SENTINEL);
            doThrow(injected).when(database).close();
            doAnswer(invocation -> {
                assertThat(Thread.holdsLock(runtime)).isFalse();
                return null;
            }).when(log).storageCloseFailed();
            assertThatThrownBy(runtime::close).isInstanceOf(IllegalStateException.class).hasCause(injected);
            verify(log).storageCloseFailed();
            verifyNoMoreInteractions(log);
        }
    }

    @Test
    void registrationReportsMalformedAndInvalidButLeavesNameConflictsQuiet() {
        var runtime = mock(ViewCoordinator.class);
        var access = new AdmissionAccess();
        var endpoints = new RuntimeEndpoints(null, null, null, null, runtime, access, null, null);
        var log = mock(OperationalLog.class);
        endpoints.setOperationalLog(log);
        assertThat(endpoints.define("{bad", null).getStatusCode().value()).isEqualTo(400);
        var view = "{\"id\":\"orders\",\"fields\":{\"value\":{\"sourceId\":\"feed\",\"type\":\"value\",\"mode\":\"arrival\"}}}";
        when(runtime.define(any())).thenThrow(new IllegalArgumentException(SENTINEL)).thenReturn(false);
        assertThat(endpoints.define(view, null).getStatusCode().value()).isEqualTo(400);
        assertThat(endpoints.define(view, null).getStatusCode().value()).isEqualTo(409);
        verify(log).registrationMalformed();
        verify(log).registrationInvalid();
        verifyNoMoreInteractions(log);
    }

    private WebSocketSession capturing(List<String> messages) throws IOException {
        var socket = mock(WebSocketSession.class);
        doAnswer(call -> {
            messages.add(((TextMessage) call.getArgument(0)).getPayload());
            return null;
        }).when(socket).sendMessage(any());
        return socket;
    }
}
