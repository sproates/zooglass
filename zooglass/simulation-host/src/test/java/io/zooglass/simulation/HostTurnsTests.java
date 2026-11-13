package io.zooglass.simulation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.node.ObjectNode;

class HostTurnsTests {
    @Test
    void aFreshHostAcceptsTheNextGlobalIdentityAndResetsOnlyMonotonicTime() {
        var turns = new HostTurns(HostProtocol.V2);

        var first = turns.admit(initialization(32, 2, 50), "initialize-document");
        var next = turns.admit(command(33, 2, 80, 30, 1_080), "observe");

        assertThat(first.id()).isEqualTo(32);
        assertThat(first.generation()).isEqualTo(new RuntimeGeneration(2, 50, 1_000));
        assertThat(first.generation().monotonicMillis(first.timeMs())).isZero();
        assertThat(first.generation().wallMillis(first.timeMs())).isEqualTo(1_050);
        assertThat(next.generation()).isSameAs(first.generation());
        assertThat(next.timeMs()).isEqualTo(80);
    }

    @Test
    void invalidOriginAndGenerationDoNotBindTheHost() {
        var turns = new HostTurns(HostProtocol.V2);

        rejects(turns, initialization(32, 1, 50), "initialize-document");
        rejects(turns, initialization(32, 17, 50), "initialize-document");
        rejects(turns, initialization(32, 2, 50).put("startTimeMs", 49), "initialize-document");
        rejects(turns, initialization(32, 2, 50).put("monotonicMs", 50), "initialize-document");
        rejects(turns, initialization(32, 2, 50).put("epochMillis", 9_007_199_254_740_991L),
                "initialize-document");
        rejects(turns, command(0, 1, 0, 0, 1_000_000), "inspect-configuration");
        rejects(turns, command(32, 2, 50, 0, 1_050), "observe");

        assertThat(turns.admit(initialization(32, 2, 50), "initialize-document").id())
                .isEqualTo(32);
    }

    @Test
    void laterCommandsCannotChangeIdentityTimeOrClockOrigin() {
        var turns = new HostTurns(HostProtocol.V2);
        turns.admit(initialization(32, 2, 50), "initialize-document");
        turns.admit(command(33, 2, 60, 10, 1_060), "observe");

        rejects(turns, command(35, 2, 61, 11, 1_061), "observe");
        rejects(turns, command(34, 3, 61, 11, 1_061), "observe");
        rejects(turns, command(34, 2, 59, 9, 1_059), "observe");
        rejects(turns, command(34, 2, 61, 61, 1_061), "observe");
        rejects(turns, command(34, 2, 61, 11, 1_060), "observe");
        rejects(turns, initialization(34, 3, 61), "initialize-document");

        assertThat(turns.admit(command(34, 2, 61, 11, 1_061), "observe").id())
                .isEqualTo(34);
    }

    @Test
    void protocolOneInspectionConsumesATurnButDoesNotBindTheEpoch() {
        var turns = new HostTurns(HostProtocol.V1);

        var inspection = turns.admit(command(0, 1, 0, 0, 1_000_000), "inspect-configuration");
        var initialized = turns.admit(
                command(1, 1, 0, 0, 123).put("epochMillis", 123), "initialize-document");

        assertThat(inspection.generation().epochMillis()).isEqualTo(1_000_000);
        assertThat(initialized.generation().epochMillis()).isEqualTo(123);
        assertThat(initialized.generation().startTimeMs()).isZero();
    }

    private static void rejects(HostTurns turns, ObjectNode command, String operation) {
        assertThatThrownBy(() -> turns.admit(command, operation))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static ObjectNode initialization(long id, long generation, long start) {
        return command(id, generation, start, 0, 1_000 + start)
                .put("epochMillis", 1_000)
                .put("startTimeMs", start);
    }

    private static ObjectNode command(long id, long generation, long at, long monotonic, long wall) {
        return HostProtocol.JSON.createObjectNode()
                .put("turnId", id)
                .put("runtimeGeneration", generation)
                .put("timeMs", at)
                .put("monotonicMs", monotonic)
                .put("wallMillis", wall);
    }
}
