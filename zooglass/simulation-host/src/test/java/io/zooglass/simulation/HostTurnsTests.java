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
        assertThat(first.generation().number()).isEqualTo(2);
        assertThat(first.generation().startTimeMs()).isEqualTo(50);
        assertThat(first.generation().epochMillis()).isEqualTo(1_000);
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
    void onlyAnAcknowledgedClockSetChangesTheExistingGenerationClock() {
        var turns = new HostTurns(HostProtocol.V2);
        var clock = turns.admit(initialization(0, 1, 0), "initialize-document").generation();

        rejects(turns, command(1, 1, 20, 20, 1_005), "observe");
        rejects(turns, command(2, 1, 20, 20, 1_005), "wall-clock-set");
        rejects(turns, command(1, 2, 20, 20, 1_005), "wall-clock-set");
        rejects(turns, command(1, 1, 20, 0, 1_005), "wall-clock-set");
        assertThat(clock.wallMillis(20)).isEqualTo(1_020);

        var adjusted = turns.admit(command(1, 1, 20, 20, 1_005), "wall-clock-set");
        assertThat(adjusted.generation()).isSameAs(clock);
        assertThat(clock.monotonicMillis(20)).isEqualTo(20);
        assertThat(clock.wallMillis(20)).isEqualTo(1_005);
        assertThat(clock.wallMillis(21)).isEqualTo(1_006);
        rejects(turns, command(2, 1, 21, 21, 1_021), "observe");
        assertThat(turns.admit(command(2, 1, 21, 21, 1_006), "observe").id()).isEqualTo(2);
    }

    @Test
    void initializationAndLaterClockReadsRespectSafeIntegerBounds() {
        long max = 9_007_199_254_740_991L;
        var turns = new HostTurns(HostProtocol.V2);
        rejects(turns, initialization(0, 1, 0).put("wallOffsetMillis", 1), "initialize-document");
        rejects(turns, initialization(0, 2, 30).put("wallOffsetMillis", -max - 1), "initialize-document");
        rejects(turns, initialization(0, 2, 30).put("wallOffsetMillis", max + 1), "initialize-document");
        rejects(turns, initialization(0, 2, 30).put("wallOffsetMillis", -1_031), "initialize-document");
        rejects(turns, initialization(0, 2, 30).put("wallOffsetMillis", 1.5), "initialize-document");

        var clock = turns.admit(initialization(0, 2, 30).put("wallOffsetMillis", -1_030)
                .put("wallMillis", 0), "initialize-document").generation();
        assertThat(clock.wallMillis(30)).isZero();
        rejects(turns, command(1, 2, 30, 0, max + 1), "wall-clock-set");
        assertThat(clock.wallMillis(30)).isZero();
        turns.admit(command(1, 2, 30, 0, max), "wall-clock-set");
        assertThat(clock.wallMillis(30)).isEqualTo(max);
        rejects(turns, command(2, 2, 31, 1, max), "observe");
        var repaired = turns.admit(command(2, 2, 31, 1, 0), "wall-clock-set");
        assertThat(repaired.generation().wallMillis(31)).isZero();

        var highEpoch = new HostTurns(HostProtocol.V2);
        highEpoch.admit(initialization(0, 1, 0).put("epochMillis", max).put("wallMillis", max),
                "initialize-document");
        rejects(highEpoch, command(1, 1, 1, 1, 1), "wall-clock-set");
    }

    @Test
    void protocolOneAndOrdinaryCommandsRejectWallAdjustmentFields() {
        assertThatThrownBy(() -> HostProtocol.V1.validateFields(command(1, 1, 0, 0, 0), "wall-clock-set"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> HostProtocol.V2.validateFields(
                command(1, 1, 0, 0, 0).put("wallOffsetMillis", 0), "observe"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> HostProtocol.V2.validateFields(
                command(1, 1, 0, 0, 0).put("wallOffsetMillis", 0), "wall-clock-set"))
                .isInstanceOf(IllegalArgumentException.class);
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
