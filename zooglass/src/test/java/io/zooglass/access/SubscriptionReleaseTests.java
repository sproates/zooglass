package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.zooglass.delivery.SnapshotBroadcaster;
import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.ViewCoordinator;

import jakarta.websocket.RemoteEndpoint;
import jakarta.websocket.SendHandler;
import jakarta.websocket.SendResult;
import jakarta.websocket.Session;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.adapter.NativeWebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

class SubscriptionReleaseTests {

    @Test
    void repeatDenialInvalidatesBeforeWaitingForCoordinatorCleanup() throws Exception {
        var access = new AdmissionAccess(new ApplicationPolicyAccess("tenant-a",
                (token, resource) -> AdmissionBoundaryTests.allow(), () -> 0),
                "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
        var resource = new ViewResource("orders", "42");
        var config = new RuntimeConfiguration(2, "memory", 10, 10, 10,
                List.of(new RuntimeConfiguration.Source("feed", "run")),
                List.of(new RuntimeConfiguration.View("orders", Map.of("value",
                        new RuntimeConfiguration.Field("feed", "value", "arrival")))));
        var viewer = mock(NativeWebSocketSession.class);
        var nativeSession = mock(Session.class);
        var remote = mock(RemoteEndpoint.Async.class);
        var firstHandoff = new LinkedBlockingQueue<SendHandler>();
        var afterAck = new CountDownLatch(1);
        var closed = new CountDownLatch(1);
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        when(viewer.isOpen()).thenReturn(true);
        when(viewer.getNativeSession(Session.class)).thenReturn(nativeSession);
        when(nativeSession.getAsyncRemote()).thenAnswer(call -> {
            if (calls.incrementAndGet() == 2) afterAck.countDown();
            return remote;
        });
        var identity = new ViewerHandshake.Identity(
                ViewerCredential.read(List.of("Bearer opaque"), List.of(), "session"), "operator");
        when(viewer.getAttributes()).thenReturn(Map.of(ViewerHandshake.IDENTITY, identity));
        doAnswer(call -> { firstHandoff.add(call.getArgument(1)); return null; })
                .when(remote).sendText(anyString(), any(SendHandler.class));
        doAnswer(call -> { closed.countDown(); return null; }).when(viewer).close(any());

        try (var runtime = new ViewCoordinator(config);
                var broadcaster = new SnapshotBroadcaster(new JsonMapper(), runtime, access)) {
            broadcaster.registerSession(viewer);
            assertThat(broadcaster.subscribe(viewer, resource,
                    new AccessGrant("tenant-a", "operator", resource, 0, 5000, () -> 0)))
                    .isEqualTo(SnapshotBroadcaster.Admission.ADMITTED);
            var ack = firstHandoff.poll(2, TimeUnit.SECONDS);
            assertThat(ack).isNotNull();
            synchronized (runtime) {
                CompletableFuture.runAsync(() -> broadcaster.refuseSubscription(viewer, "orders", "42", "accessDenied"))
                        .get(1, TimeUnit.SECONDS);
                ack.onResult(new SendResult());
                assertThat(afterAck.await(2, TimeUnit.SECONDS)).isTrue();
            }
            assertThat(closed.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(firstHandoff).isEmpty();
        } finally {
            access.close();
        }
    }
}
