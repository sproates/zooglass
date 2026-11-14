package io.zooglass.simulation;

import static io.zooglass.simulation.HostProtocol.integer;
import static io.zooglass.simulation.HostProtocol.signedInteger;

import tools.jackson.databind.JsonNode;

/** Admits one generation and its consecutive sequence of globally identified commands. */
final class HostTurns {
    private static final int COMMAND_LIMIT = 10_000;
    private static final int GENERATION_LIMIT = 16;

    private final HostProtocol protocol;
    private RuntimeGeneration generation;
    private long nextTurn;
    private long lastTimeMs;
    private int commands;

    HostTurns(HostProtocol protocol) {
        this.protocol = protocol;
    }

    record Turn(long id, long timeMs, RuntimeGeneration generation) {}

    Turn admit(JsonNode command, String operation) {
        long id = integer(command, "turnId");
        long at = integer(command, "timeMs");
        boolean inspection = operation.equals("inspect-configuration");
        boolean initializing = operation.equals("initialize") || operation.equals("initialize-document");
        boolean adjusting = operation.equals("wall-clock-set");
        if (adjusting && protocol != HostProtocol.V2)
            throw new IllegalArgumentException("Wall adjustments require protocol 2");
        RuntimeGeneration clock;
        if (inspection) {
            if (protocol != HostProtocol.V1 || generation != null || at != 0)
                throw new IllegalArgumentException("Configuration admission requires an unstarted v1 host");
            clock = RuntimeGeneration.FIXED_PROOF;
        } else if (initializing && generation == null) {
            clock = initialize(command, operation, at);
        } else {
            if (initializing || generation == null)
                throw new IllegalArgumentException("Invalid lifecycle");
            clock = generation;
        }

        if (commands >= COMMAND_LIMIT
                || ((protocol == HostProtocol.V1 || commands != 0) && id != nextTurn)
                || at < lastTimeMs || at > TurnContext.MAX_TIME_MS
                || integer(command, "runtimeGeneration") != clock.number()
                || integer(command, "monotonicMs") != clock.monotonicMillis(at))
            throw new IllegalArgumentException("Invalid command identity or clocks");
        if (protocol == HostProtocol.V1 && id == 0 && at != 0)
            throw new IllegalArgumentException("Initial elapsed time must be zero");
        long wallMillis = integer(command, "wallMillis");
        if (adjusting) clock.setWallMillis(at, wallMillis);
        else if (wallMillis != clock.wallMillis(at))
            throw new IllegalArgumentException("Invalid command identity or clocks");

        commands++;
        nextTurn = id + 1;
        lastTimeMs = at;
        if (!inspection) generation = clock;
        return new Turn(id, at, clock);
    }

    private RuntimeGeneration initialize(JsonNode command, String operation, long at) {
        if (protocol == HostProtocol.V1) {
            if (operation.equals("initialize")) return RuntimeGeneration.FIXED_PROOF;
            return new RuntimeGeneration(1, 0, integer(command, "epochMillis"));
        }

        if (!operation.equals("initialize-document"))
            throw new IllegalArgumentException("Protocol 2 requires document initialization");
        long number = integer(command, "runtimeGeneration");
        long start = integer(command, "startTimeMs");
        long offset = command.has("wallOffsetMillis") ? signedInteger(command, "wallOffsetMillis") : 0;
        if (number < 1 || number > GENERATION_LIMIT
                || start != at || (number == 1 && (start != 0 || offset != 0)))
            throw new IllegalArgumentException("Invalid generation origin");
        return new RuntimeGeneration(number, start, integer(command, "epochMillis"), offset);
    }
}
