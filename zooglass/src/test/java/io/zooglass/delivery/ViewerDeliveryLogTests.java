package io.zooglass.delivery;

import io.zooglass.access.AccessDecision;
import io.zooglass.access.AdmissionAccess;
import io.zooglass.access.ViewerHandshake;
import io.zooglass.logging.ViewerLog;
import io.zooglass.logging.ViewerLogCapture;
import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.ViewCoordinator;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

class ViewerDeliveryLogTests {
    private final JsonMapper json = new JsonMapper();

    private static WebSocketSession session(String id) {
        var session = ResumableWriterTests.session(id);
        when(session.getAttributes()).thenReturn(new java.util.concurrent.ConcurrentHashMap<>());
        return session;
    }

    private static RuntimeConfiguration config() {
        return new RuntimeConfiguration(2, "memory", 20, 20, 20, List.of(), List.of(),
                new RuntimeConfiguration.Delivery(null, null, 2, 1024L));
    }

    @Test
    void oversizedFullAndFailedWritesRequestClosureButOnlyCallbackConfirmsIt() throws Exception {
        String id = "SENTINEL-session\nprivate";
        try (var capture = new ViewerLogCapture(); var runtime = new ViewCoordinator(config())) {
            var driver = new ControlledDeliveryDriver();
            var access = new AdmissionAccess();
            var log = capture.operations.viewers();
            try (var broadcaster = new SnapshotBroadcaster(json, runtime, access, driver, log)) {
                var subscriptions = new SnapshotSubscriptions(json, broadcaster, access, log);
                var session = session(id);
                subscriptions.afterConnectionEstablished(session);
                var reference = capture.next("connection.opened").get("connectionRef");
                assertThat(reference).isInstanceOf(Long.class);
                subscriptions.handleTextMessage(session, new TextMessage("{SENTINEL-invalid\n"));
                assertThat(capture.next("request.invalid")).containsEntry("connectionRef", reference)
                        .containsEntry("reason", "invalidViewRequest");
                broadcaster.sendError(session, "SENTINEL " + "x".repeat(1100));
                assertThat(capture.next("delivery.close_requested")).containsEntry("reason", "tooLarge")
                        .containsEntry("connectionRef", reference);
                driver.runTurns();
                assertThat(driver.closes).containsExactly(id + ":1009");
                assertThat(capture.records).isEmpty();
                subscriptions.afterConnectionClosed(session, new CloseStatus(1009, "SENTINEL-private\nclose"));
                assertThat(capture.next("connection.closed")).containsEntry("reason", "other")
                        .containsEntry("connectionRef", reference);
                subscriptions.afterConnectionClosed(session, CloseStatus.NORMAL);
                assertThat(capture.records).isEmpty();
                assertThat(session.getAttributes()).isEmpty();

                var full = session("SENTINEL-full");
                broadcaster.registerSession(full);
                for (int i = 0; i < 3; i++) broadcaster.sendError(full, "SENTINEL-queued");
                assertThat(capture.next("delivery.close_requested")).containsEntry("reason", "queueFull");
                driver.runTurns();
                var broken = session("SENTINEL-broken");
                broadcaster.registerSession(broken);
                broadcaster.sendError(broken, "SENTINEL-message");
                driver.runTurns();
                var handoff = driver.handoffs.remove();
                handoff.completion().accept(new IOException("SENTINEL-failure", new IOException("SENTINEL-cause")));
                assertThat(capture.next("delivery.close_requested")).containsEntry("reason", "writerFailed");
                driver.runTurns();
                assertThat(driver.closes).containsExactly(id + ":1009", "SENTINEL-full:1013", "SENTINEL-broken:1013");
            }
        }
    }

    @Test
    void blockedDeliveryAppenderLeavesTheCoordinatorAvailable() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var capture = new ViewerLogCapture(event -> {
            entered.countDown();
            await(release);
        }); var runtime = new ViewCoordinator(config());
                var broadcaster = new SnapshotBroadcaster(json, runtime, new AdmissionAccess(),
                        new ControlledDeliveryDriver(), capture.operations.viewers())) {
            var session = session("SENTINEL-blocked");
            broadcaster.registerSession(session);
            var call = CompletableFuture.runAsync(() -> broadcaster.sendError(session, "x".repeat(1100)));
            try {
                assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
                call.get(3, TimeUnit.SECONDS);
                CompletableFuture.runAsync(() -> {
                    synchronized (runtime) { runtime.delivery(); }
                }).get(3, TimeUnit.SECONDS);
            } finally {
                release.countDown();
            }
            assertThat(capture.next("delivery.close_requested")).containsEntry("reason", "tooLarge");
        } finally {
            release.countDown();
        }
    }

    @Test
    void subscriptionInvalidationPrecedesPotentiallyBlockingRefusalRecord() throws Exception {
        var access = mock(AdmissionAccess.class);
        when(access.protectedMode()).thenReturn(true);
        when(access.authorise(any(), any())).thenReturn(new AccessDecision.Rejected(AccessDecision.Reason.DENIED));
        var broadcaster = mock(SnapshotBroadcaster.class);
        var subscriptions = new SnapshotSubscriptions(json, broadcaster, access);
        var session = session("private");
        session.getAttributes().put(ViewerHandshake.IDENTITY, new ViewerHandshake.Identity(null, "SENTINEL"));
        subscriptions.handleTextMessage(session, new TextMessage(
                "{\"action\":\"subscribe\",\"viewId\":\"live\",\"entityId\":\"SENTINEL\"}"));
        var order = inOrder(access, broadcaster);
        order.verify(broadcaster).refuseSubscription(session, "live", "SENTINEL", "accessDenied");
        order.verify(access).recordRejection(ViewerLog.Boundary.SUBSCRIPTION, AccessDecision.Reason.DENIED);
    }

    @Test
    void transportCloseFailureReportsTheStageWithoutExceptionText() throws Exception {
        try (var capture = new ViewerLogCapture(); var driver = new SocketDeliveryDriver(capture.operations.viewers())) {
            var session = session("SENTINEL-close");
            doThrow(new IOException("SENTINEL-failure\n", new IOException("SENTINEL-cause")))
                    .when(session).close(CloseStatus.SERVER_ERROR);
            driver.closeSession(session, CloseStatus.SERVER_ERROR);
            assertThat(capture.next("delivery.failed")).containsEntry("reason", "closeFailed")
                    .containsEntry("stage", "close").containsEntry("failureCategory", "transport");
            assertThat(capture.records).isEmpty();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(8, TimeUnit.SECONDS)) throw new AssertionError("Logging barrier timed out");
        } catch (InterruptedException interrupted) {
            throw new AssertionError(interrupted);
        }
    }
}
