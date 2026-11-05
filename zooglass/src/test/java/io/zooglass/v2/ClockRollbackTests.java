package io.zooglass.v2;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ClockRollbackTests {

    @Test
    void roundingIsToleratedButSeveralSmallLossesAccumulate() {
        var observations = new ClockRollback();
        observations.start(new ReceiptClock.Sample(0, 1000, 0));
        var first = new ReceiptClock.Sample(100, 1099, 100);
        assertThat(observations.detected(first)).isFalse();
        observations.committed(first, false);
        assertThat(observations.detected(new ReceiptClock.Sample(200, 1198, 200))).isTrue();
    }

    @Test
    void schedulingPauseAroundWallReadIsNotEvidenceOfRollback() {
        var observations = new ClockRollback();
        observations.start(new ReceiptClock.Sample(0, 1000, 0));
        var paused = new ReceiptClock.Sample(20, 1020, 100);
        assertThat(observations.detected(paused)).isFalse();
        observations.committed(paused, false);
        assertThat(observations.detected(new ReceiptClock.Sample(110, 1110, 110))).isFalse();
    }
}
