package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verifyNoInteractions;

import io.zooglass.delivery.SnapshotBroadcaster;
import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.ViewCoordinator;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

class AdmissionDeadlineTests {

    @Test
    void expiredOrWrongTenantDecisionsCannotReachSnapshotLookup() {
        var clock = new AtomicLong();
        var resource = new ViewResource("match", "42");
        var runtime = mock(ViewCoordinator.class);
        for (String tenant : List.of("tenant-a", "wrong-tenant")) {
            var grant = new AccessGrant(tenant, "subject", resource, 0, 1, clock::get);
            var access = new AdmissionAccess(fixed(grant), "tenant-a", AdmissionBoundaryTests.ORIGIN, "session");
            clock.set("tenant-a".equals(tenant) ? 1_000_000 : 0);
            assertThat(new SnapshotAdmission(access, runtime)
                    .read(AdmissionBoundaryTests.request(), "match", "42").getStatusCode().value())
                    .isEqualTo(503);
        }
        verifyNoInteractions(runtime);
    }

    @Test
    void deadlineIsCheckedAfterPreparingTheOpeningMessages() {
        var json = mock(JsonMapper.class);
        var realJson = new JsonMapper();
        var clock = new AtomicLong();
        var config = new RuntimeConfiguration(2, "memory", 10, 10, 10,
                List.of(new RuntimeConfiguration.Source("feed", "run")),
                List.of(new RuntimeConfiguration.View("match", Map.of("value",
                        new RuntimeConfiguration.Field("feed", "value", "arrival")))));
        doAnswer(call -> {
            clock.set(1_000_000);
            return realJson.writeValueAsString(call.getArgument(0));
        }).when(json).writeValueAsString(any());
        var resource = new ViewResource("match", "42");
        var grant = new AccessGrant("tenant-a", "subject", resource, 0, 1, clock::get);
        try (var runtime = new ViewCoordinator(config); var broadcaster = new SnapshotBroadcaster(json, runtime)) {
            var session = mock(WebSocketSession.class);
            when(session.isOpen()).thenReturn(true);
            broadcaster.registerSession(session);
            assertThat(broadcaster.subscribe(session, "match", "42", () -> grant.permits(resource)))
                    .isEqualTo(SnapshotBroadcaster.Admission.REFUSED);
            org.mockito.Mockito.verify(session, org.mockito.Mockito.never()).sendMessage(any());
        } catch (java.io.IOException unexpected) {
            throw new AssertionError(unexpected);
        }
    }

    private ViewerAccess fixed(AccessGrant grant) {
        return new ViewerAccess() {
            public AccessDecision authenticate(ViewerCredential credential) {
                return new AccessDecision.Granted(grant);
            }
            public AccessDecision authorise(ViewerCredential credential, ViewResource resource) {
                return new AccessDecision.Granted(grant);
            }
            public void close() {}
        };
    }
}
