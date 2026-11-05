package io.zooglass.v2;

import io.zooglass.strategy.freshness.ReceiptAge;

import java.util.HashMap;

/** Elapsed time is still reliable in-process. Flag pre-jump receipts for the next restart. */
final class ClockRollback {

    private long previousWall;
    private long highestMinimumOffset;

    void start(ReceiptClock.Sample sample) {
        previousWall = sample.wall();
        highestMinimumOffset = sample.minimumOffset();
    }

    boolean detected(ReceiptClock.Sample sample) {
        // Independently rounded millisecond clocks can differ by one tick.
        return sample.wall() < previousWall || sample.maximumOffset() < highestMinimumOffset - 1;
    }

    void committed(ReceiptClock.Sample sample, boolean rollback) {
        previousWall = sample.wall();
        highestMinimumOffset =
                rollback
                        ? sample.minimumOffset()
                        : Math.max(highestMinimumOffset, sample.minimumOffset());
    }

    static StateImage markRetainedReceipts(StateImage old, StateImage next) {
        var rows = new HashMap<>(next.views());
        for (var entry : old.views().entrySet()) {
            var row = rows.get(entry.getKey());
            for (var field : entry.getValue().candidates().entrySet()) {
                for (var source : field.getValue().entrySet()) {
                    var retained = row.candidates().get(field.getKey()).get(source.getKey());
                    var age = retained.age();
                    // A candidate replaced by this event was received after the clock jump.
                    // Expiry changes age metadata but keeps the same immutable value.
                    if ((retained.value() != source.getValue().value()
                                    && age != source.getValue().age())
                            || age == null
                            || age.receivedAtMillis() == null
                            || age.hasUncertainClock()) {
                        continue;
                    }
                    var flagged =
                            new ReceiptAge(age.receivedAtMillis(), age.classification(), true);
                    row =
                            row.replaceCandidate(
                                    field.getKey(),
                                    source.getKey(),
                                    retained.withAge(flagged),
                                    row.version());
                }
            }
            rows.put(entry.getKey(), row);
        }
        return new StateImage(next.version(), next.streams(), rows, next.lastWallMillis());
    }
}
