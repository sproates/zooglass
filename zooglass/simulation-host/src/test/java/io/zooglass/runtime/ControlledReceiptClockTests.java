package io.zooglass.runtime;

import static org.assertj.core.api.Assertions.assertThat;

import io.zooglass.simulation.RuntimeGeneration;
import io.zooglass.simulation.TurnContext;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Map;

class ControlledReceiptClockTests {
    @Test
    void receiptClockRestartsAtZeroWhileAlarmsStayOnTheGlobalAgenda() {
        var turns = new TurnContext();
        var generation = new RuntimeGeneration(2, 50, 1_000);
        var clock = new ControlledReceiptClock(turns, generation);
        var alarms = new ControlledAlarmScheduler(turns);
        var samples = new ArrayList<ReceiptClock.Sample>();

        turns.begin(50);
        assertThat(clock.sample()).isEqualTo(new ReceiptClock.Sample(0, 1_050, 0));
        alarms.schedule(() -> samples.add(clock.sample()), 30);
        assertThat(turns.end()).containsExactly(Map.of(
                "kind", "schedule", "task", 1L, "at", 80L, "phase", 1, "taskKind", "alarm"));

        turns.begin(80);
        turns.dispatch(1);
        assertThat(samples).containsExactly(new ReceiptClock.Sample(30, 1_080, 30));
        alarms.close();
        assertThat(turns.end()).isEmpty();
    }
}
