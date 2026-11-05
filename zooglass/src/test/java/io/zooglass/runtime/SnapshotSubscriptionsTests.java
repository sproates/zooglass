package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.zooglass.delivery.SnapshotBroadcaster;
import io.zooglass.delivery.SnapshotSubscriptions;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

class SnapshotSubscriptionsTests {
    @TempDir Path directory;

    @Test
    void failedStorageIsReportedAsAProcessingErrorRatherThanMalformedInput() throws Exception {
        var file = directory.resolve("failed-storage.db");
        var mapper = new JsonMapper();
        var config =
                new RuntimeConfiguration(
                        2,
                        "sqlite",
                        10,
                        10,
                        10,
                        List.of(new RuntimeConfiguration.Source("feed", "run")),
                        List.of(
                                new RuntimeConfiguration.View(
                                        "view",
                                        Map.of(
                                                "value",
                                                new RuntimeConfiguration.Field(
                                                        "feed", "value", "arrival")))));
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            runtime.apply(
                    new Publication("feed", "run", "item", 1, "value", mapper.readTree("{}")));
        }
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file);
                var statement = connection.createStatement()) {
            statement.execute(
                    "CREATE TRIGGER refuse_view BEFORE INSERT ON views "
                            + "BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
        }
        try (var runtime = new ViewCoordinator(config, file.toString());
                var delivery = new SnapshotBroadcaster(mapper, runtime)) {
            var publication =
                    new Publication("feed", "run", "item", 2, "value", mapper.readTree("{}"));
            assertThatThrownBy(() -> runtime.apply(publication))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(runtime.healthy()).isFalse();

            var messages = new LinkedBlockingQueue<String>();
            var session = mock(WebSocketSession.class);
            when(session.isOpen()).thenReturn(true);
            when(session.getId()).thenReturn("failed-storage-client");
            doAnswer(
                            call -> {
                                messages.add(((TextMessage) call.getArgument(0)).getPayload());
                                return null;
                            })
                    .when(session)
                    .sendMessage(any());
            var handler = new SnapshotSubscriptions(mapper, delivery);
            handler.afterConnectionEstablished(session);
            handler.handleMessage(
                    session,
                    new TextMessage(
                            """
                            {"action":"subscribe","viewId":"view","entityId":"item"}
                            """));
            assertThat(messages.poll(5, TimeUnit.SECONDS))
                    .isEqualTo(
                            "{\"type\":\"error\",\"message\":\"Could not process live view"
                                + " request.\"}");

            // The connection remains usable for request validation and cleanup.
            handler.handleMessage(session, new TextMessage("{"));
            assertThat(messages.poll(5, TimeUnit.SECONDS))
                    .isEqualTo(
                            "{\"type\":\"error\",\"message\":\"Could not read live view"
                                + " request.\"}");
            handler.handleMessage(
                    session,
                    new TextMessage(
                            """
                            {"action":"unsubscribe","viewId":"view","entityId":"item"}
                            """));
            assertThat(messages.poll(5, TimeUnit.SECONDS))
                    .isEqualTo(
                            "{\"type\":\"unsubscribed\",\"viewId\":\"view\",\"entityId\":\"item\"}");
        }
    }
}
