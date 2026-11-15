package io.zooglass.simulation;

import java.util.*;

/** Diagnostic-only host pauses. Never changes clocks, effects, ordering or worker ownership. */
final class HostTimingProbe {
    private final int millis = Integer.parseInt(System.getProperty("zooglass.simulation.pauseMillis", "0"));
    private final Map<String, Map<String, Object>> pauses = new LinkedHashMap<>();

    HostTimingProbe() {
        if (millis < 0 || millis > 250) throw new IllegalArgumentException("Invalid host pause");
    }

    void pause(String site, long virtualMs) {
        if (millis == 0 || pauses.containsKey(site)) return;
        if (!Set.of("state-effect", "alarm-dispatch", "writer-handoff").contains(site))
            throw new IllegalArgumentException("Unknown host pause site");
        long start = System.nanoTime();
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Host pause interrupted", interrupted);
        }
        pauses.put(site, Map.of("site", site, "requestedMillis", millis,
                "elapsedNanos", System.nanoTime() - start, "virtualMs", virtualMs));
    }

    Map<String, Object> diagnostics() {
        return Map.of("pauseMillis", millis, "pauses", List.copyOf(pauses.values()));
    }
}
