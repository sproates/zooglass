package io.zooglass.delivery;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import io.zooglass.access.AdmissionAccess;
import io.zooglass.runtime.Publication;
import io.zooglass.runtime.RuntimeConfiguration;
import io.zooglass.runtime.ViewCoordinator;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.web.socket.WebSocketSession;

import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Map;

class ControlledBroadcasterTests {
    private final JsonMapper json = new JsonMapper();

    @ParameterizedTest
    @ValueSource(strings = {"disconnectOnOverflow", "coalesceLatestState"})
    void stalledSubscriberUsesRealBudgetsWhileHealthySubscriberContinues(String policy) {
        var config =
                new RuntimeConfiguration(
                        2,
                        "memory",
                        20,
                        20,
                        20,
                        List.of(new RuntimeConfiguration.Source("feed", "v1")),
                        List.of(
                                new RuntimeConfiguration.View(
                                        "position",
                                        Map.of(
                                                "position",
                                                new RuntimeConfiguration.Field(
                                                        "feed", "position", "arrival")))),
                        new RuntimeConfiguration.Delivery(
                                null, SlowClientPolicy.select(policy), 2, 4096L));
        var driver = new ControlledDeliveryDriver();
        var slow = ResumableWriterTests.session("slow");
        var healthy = ResumableWriterTests.session("healthy");
        try (var runtime = new ViewCoordinator(config);
                var broadcaster =
                        new SnapshotBroadcaster(json, runtime, new AdmissionAccess(), driver)) {
            for (var session : List.of(slow, healthy)) {
                broadcaster.registerSession(session);
                broadcaster.subscribe(session, "position", "bus");
            }
            assertThat(driver.handoffs).isEmpty();
            driver.runTurns();
            var held = driver.handoffs.remove();
            assertThat(held.session()).isSameAs(slow);
            assertThat(json.readTree(held.payload()).path("type").asString())
                    .isEqualTo("subscribed");
            var ack = driver.handoffs.remove();
            assertThat(ack.session()).isSameAs(healthy);
            ack.finish();
            finishSnapshot(driver, healthy, 0);
            for (int sequence = 1; sequence <= 2; sequence++) {
                runtime.apply(
                        new Publication(
                                "feed",
                                "v1",
                                "bus",
                                sequence,
                                "position",
                                json.createObjectNode().put("sequence", sequence)));
                if (sequence == 2) assertThat(driver.closes).isEmpty();
                finishSnapshot(driver, healthy, sequence);
            }
            if (policy.equals("disconnectOnOverflow")) {
                assertThat(driver.closes).containsExactly("slow:1013");
                held.finish();
                driver.runTurns();
                assertThat(driver.handoffs).isEmpty();
                // A stale handoff completion cannot remove the newly registered writer.
                broadcaster.registerSession(slow);
                broadcaster.sendError(slow, "new writer");
                held.completion().accept(new java.io.IOException("late old failure"));
                driver.runTurns();
                assertThat(driver.handoffs.remove().payload()).contains("new writer");
                assertThat(driver.closes).containsExactly("slow:1013");
            } else {
                assertThat(driver.closes).isEmpty();
                held.finish();
                finishSnapshot(driver, slow, 0);
                finishSnapshot(driver, slow, 2);
            }
            verify(slow, never()).sendMessage(any());
            verify(healthy, never()).sendMessage(any());
        } catch (java.io.IOException failure) {
            throw new AssertionError(failure);
        }
        assertThat(driver.closed).isTrue();
        assertThat(driver.turns).isEmpty();
    }

    @org.junit.jupiter.api.Test
    void recipientsScheduleInAdmissionOrderAndClosedBroadcasterRejectsRegistration() {
        var config =
                new RuntimeConfiguration(
                        2,
                        "memory",
                        20,
                        20,
                        20,
                        List.of(new RuntimeConfiguration.Source("feed", "v1")),
                        List.of(
                                new RuntimeConfiguration.View(
                                        "position",
                                        Map.of(
                                                "position",
                                                new RuntimeConfiguration.Field(
                                                        "feed", "position", "arrival")))));
        var driver = new ControlledDeliveryDriver();
        var first = ResumableWriterTests.session("zebra");
        var second = ResumableWriterTests.session("ant");
        try (var runtime = new ViewCoordinator(config);
                var broadcaster =
                        new SnapshotBroadcaster(json, runtime, new AdmissionAccess(), driver)) {
            for (var session : List.of(first, second)) {
                broadcaster.registerSession(session);
                broadcaster.subscribe(session, "position", "bus");
                driver.runTurns();
                driver.handoffs.remove().finish();
                finishSnapshot(driver, session, 0);
            }
            runtime.apply(
                    new Publication("feed", "v1", "bus", 1, "position", json.createObjectNode()));
            driver.runTurns();
            assertThat(driver.handoffs)
                    .extracting(frame -> frame.session().getId())
                    .containsExactly("zebra", "ant");
            broadcaster.close();
            driver.handoffs.forEach(ControlledDeliveryDriver.Handoff::finish);
            assertThat(driver.turns).isEmpty();
            org.assertj.core.api.Assertions.assertThatThrownBy(
                            () -> broadcaster.registerSession(first))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    @org.junit.jupiter.api.Test
    void shutdownCancelsWritersInRegistrationOrderRegardlessOfSessionHashes() {
        var config = new RuntimeConfiguration(2, "memory", 20, 20, 20, List.of(), List.of());
        var driver = new ControlledDeliveryDriver();
        var first =
                new org.springframework.web.socket.handler.WebSocketSessionDecorator(
                        ResumableWriterTests.session("first")) {
                    @Override
                    public int hashCode() {
                        return 2;
                    }
                };
        var second =
                new org.springframework.web.socket.handler.WebSocketSessionDecorator(
                        ResumableWriterTests.session("second")) {
                    @Override
                    public int hashCode() {
                        return 1;
                    }
                };
        try (var runtime = new ViewCoordinator(config);
                var broadcaster =
                        new SnapshotBroadcaster(json, runtime, new AdmissionAccess(), driver)) {
            broadcaster.registerSession(first);
            broadcaster.registerSession(second);
            broadcaster.close();
            assertThat(driver.stoppedSessions).containsExactly("first", "second");
            broadcaster.close();
            assertThat(driver.stoppedSessions).containsExactly("first", "second");
        }
    }

    private void finishSnapshot(
            ControlledDeliveryDriver driver, WebSocketSession session, long version) {
        driver.runTurns();
        var frame = driver.handoffs.remove();
        assertThat(frame.session()).isSameAs(session);
        assertThat(json.readTree(frame.payload()).path("version").longValue()).isEqualTo(version);
        frame.finish();
        driver.runTurns();
    }
}
