package io.zooglass;

import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.json.JsonMapper;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ResourceBehaviourTests {
    private final JsonMapper json = JsonMapper.builder().build();

    @Test
    void historyGrowthIsRetainedDataAndDuplicatesDoNotGrowIt() throws Exception {
        var store = new ViewStore(new ViewConfiguration(List.of(
                new ViewConfiguration.ViewDefinition("history", Map.of(
                        "positions", List.of(new ViewConfiguration.EventMatcher("feed", "position"))),
                        Map.of("positions", new ViewConfiguration.Ordering("historyBySequence", "sequence"))))));
        var observations = new ArrayList<Map<String, Long>>();
        long previousBytes = 0;
        int nextSequence = 1;
        for (int count : List.of(100, 500, 1000)) {
            while (nextSequence <= count) {
                store.apply("feed", "position", "bus", json.createObjectNode().put("sequence", nextSequence++));
            }
            var snapshot = store.get("history", "bus").orElseThrow();
            var positions = snapshot.data().get("positions");
            assertThat(positions.size()).isEqualTo(count);
            for (int index = 0; index < count; index++) {
                assertThat(positions.get(index).get("sequence").intValue()).isEqualTo(index + 1);
            }
            long bytes = json.writeValueAsBytes(snapshot).length;
            assertThat(bytes).isGreaterThan(previousBytes);
            // Linear serialized state bound, deliberately separate from JVM heap.
            assertThat(bytes).isLessThan(64L * count + 256);
            for (int sequence = 1; sequence <= count; sequence++) {
                assertThat(store.apply("feed", "position", "bus",
                        json.createObjectNode().put("sequence", sequence))).isEmpty();
            }
            assertThat(store.get("history", "bus")).contains(snapshot);
            observations.add(Map.of("positions", (long) count, "serializedBytes", bytes,
                    "heapUsedBytes", ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed()));
            previousBytes = bytes;
        }
        Files.writeString(Path.of("target/resource-observations.json"), json.writeValueAsString(Map.of(
                "javaVersion", System.getProperty("java.version"),
                "heapInterpretation", "Observational: includes allocations, other tests and GC timing; not a leak threshold",
                "history", observations)));
    }

    @Test
    void repeatedSessionRemovalDrainsQueuesAndTerminatesWriters() throws Exception {
        var store = new ViewStore(new ViewConfiguration(List.of(
                new ViewConfiguration.ViewDefinition("position", Map.of(
                        "position", List.of(new ViewConfiguration.EventMatcher("feed", "position")))))));
        var broadcaster = new LiveViewBroadcaster(json, store);
        var executor = (ExecutorService) ReflectionTestUtils.getField(broadcaster, "outboundExecutor");
        assertThat(executor).isNotNull();
        try {
            for (int cycle = 0; cycle < 100; cycle++) {
                var entered = new CountDownLatch(1);
                var stopped = new CountDownLatch(1);
                var release = new CountDownLatch(1);
                var client = mock(WebSocketSession.class);
                when(client.isOpen()).thenReturn(true);
                doAnswer(invocation -> {
                    entered.countDown();
                    try { release.await(); }
                    catch (InterruptedException exception) { stopped.countDown(); throw exception; }
                    return null;
                }).when(client).sendMessage(any(TextMessage.class));
                try {
                    broadcaster.registerSession(client);
                    broadcaster.subscribe(client, "position", "bus");
                    assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                    var writers = registry(broadcaster, "writersBySession");
                    Object writer = writers.get(client);
                    var queue = (Queue<?>) ReflectionTestUtils.getField(writer, "messages");
                    for (int update = 0; update < 25; update++)
                        broadcaster.apply("feed", "position", "bus", json.createObjectNode().put("sequence", update));
                    assertThat(queue).isNotEmpty();
                    broadcaster.removeSession(client);
                    assertThat(stopped.await(5, TimeUnit.SECONDS)).isTrue();
                    assertThat(queue).isEmpty();
                    for (String field : List.of("writersBySession", "sessionsBySubscription", "subscriptionsBySession"))
                        assertThat(registry(broadcaster, field)).as("cycle %s: %s", cycle, field).isEmpty();
                } finally { release.countDown(); broadcaster.removeSession(client); }
            }
        } finally { broadcaster.close(); }
        assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
    }

    // White-box ownership evidence: aggregate heap alone cannot identify which
    // queues or subscriptions remain reachable after their session has gone.
    private static Map<?, ?> registry(LiveViewBroadcaster broadcaster, String field) {
        return (Map<?, ?>) ReflectionTestUtils.getField(broadcaster, field);
    }
}
