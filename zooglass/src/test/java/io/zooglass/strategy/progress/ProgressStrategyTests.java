package io.zooglass.strategy.progress;

import io.zooglass.strategy.late.AcceptLate;
import io.zooglass.strategy.late.LateStrategySelection;
import io.zooglass.strategy.late.RejectBehindWatermark;
import io.zooglass.v2.PublicationJson;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Random;

import static org.assertj.core.api.Assertions.*;

class ProgressStrategyTests {
    @Test
    void concreteModulesAndLatePolicyAreSelected() {
        var untracked = ProgressStrategySelection.select("untracked", null, null, null);
        assertThat(untracked).isInstanceOf(UntrackedProgress.class);
        assertThat(untracked.receive(null, 42, 1)).isNull();
        assertThat(untracked.missing(null, 1)).isEmpty();
        untracked.validate(null, 1, 0);
        assertThatThrownBy(() -> untracked.advance(null, 42, 1, 1)).hasMessage("progressUntracked");
        assertThat(LateStrategySelection.select("acceptLate")).isInstanceOf(AcceptLate.class);
        var reject = LateStrategySelection.select("rejectBehindWatermark");
        assertThat(reject).isInstanceOf(RejectBehindWatermark.class);
        assertThat(reject.accepts(41, null)).isTrue();
        assertThat(reject.accepts(41, 40L)).isTrue();
        assertThat(reject.accepts(41, 41L)).isFalse();
        assertThat(new AcceptLate().accepts(1, 900L)).isTrue();
        assertThatThrownBy(() -> LateStrategySelection.select("other")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void classificationsSplitAtWatermarkAndFloorWithoutAllocatingBySequenceDistance() {
        var policy = ProgressStrategySelection.select("contiguousSequence", 40L, 3L, 3L);
        var state = policy.receive(policy.initial(), 40, 1);
        state = policy.receive(state, 45, 1);
        state = policy.advance(state, 43, 3, 42);
        assertThat(policy.missing(state, 42)).containsExactly(
                new ProgressState.Missing(41, 41, "expired"),
                new ProgressState.Missing(42, 43, "confirmed"),
                new ProgressState.Missing(44, 44, "provisional"));
        assertThatThrownBy(() -> policy.receive(policy.initial(), 39, 1)).hasMessage("beforeProgressStart");
        assertThatThrownBy(() -> policy.advance(policy.initial(), 39, 1, 1)).hasMessage("invalidProgress");
        var at43 = state;
        assertThatThrownBy(() -> policy.advance(at43, 42, 4, 42)).hasMessage("backwardsWatermark");
        var huge = policy.advance(policy.initial(), PublicationJson.MAX_SEQUENCE, 1, 1);
        assertThat(policy.missing(huge, 1)).containsExactly(
                new ProgressState.Missing(40, PublicationJson.MAX_SEQUENCE, "confirmed"));
    }

    @Test
    void rangeBoundsRejectFragmentationAndClassificationSplits() {
        var receivedBound = ProgressStrategySelection.select("contiguousSequence", 1L, 1L, 10L);
        var two = receivedBound.receive(receivedBound.initial(), 2, 1);
        assertThatThrownBy(() -> receivedBound.receive(two, 4, 1)).hasMessage("progressLimit");
        assertThat(receivedBound.receive(two, 1, 1).receivedThrough()).isEqualTo(2);
        var missingBound = ProgressStrategySelection.select("contiguousSequence", 1L, 10L, 1L);
        var five = missingBound.receive(missingBound.initial(), 5, 1);
        assertThatThrownBy(() -> missingBound.advance(five, 3, 2, 1)).hasMessage("progressLimit");
        assertThatThrownBy(() -> missingBound.receive(five, 6, 3)).hasMessage("progressLimit");
    }

    @Test
    void seededArrivalOrdersAgreeWithIndependentReceivedSetAndPreserveInputs() {
        var policy = ProgressStrategySelection.select("contiguousSequence", 1L, 20L, 20L);
        for (int seed = 0; seed < 32; seed++) {
            var arrivals = new ArrayList<>(List.of(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L));
            Collections.shuffle(arrivals, new Random(seed));
            var seen = new HashSet<Long>();
            var state = policy.initial();
            long observed = 0;
            for (long sequence : arrivals) {
                var before = state;
                var retainedRanges = List.copyOf(before.received());
                state = policy.receive(state, sequence, 1);
                seen.add(sequence);
                observed = Math.max(observed, sequence);
                var missing = new ArrayList<Long>();
                for (long candidate = 1; candidate <= observed; candidate++) if (!seen.contains(candidate)) missing.add(candidate);
                var actual = new ArrayList<Long>();
                for (var range : policy.missing(state, 1)) {
                    assertThat(range.status()).isEqualTo("provisional");
                    for (long candidate = range.from(); candidate <= range.through(); candidate++) actual.add(candidate);
                }
                assertThat(actual).isEqualTo(missing);
                assertThat(before.received()).isEqualTo(retainedRanges);
                policy.validate(state, 1, 10);
            }
            assertThat(state.receivedThrough()).isEqualTo(8);
            assertThat(state.received()).isEmpty();
        }
    }
}
