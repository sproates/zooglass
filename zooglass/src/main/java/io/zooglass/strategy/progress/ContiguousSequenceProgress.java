package io.zooglass.strategy.progress;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import io.zooglass.v2.PublicationJson;

/** Bounded interval arithmetic over one declared sequence domain, never over individual missing integers. */
public final class ContiguousSequenceProgress implements ProgressStrategy {
    private final long start;
    private final long maxReceived;
    private final long maxMissing;

    ContiguousSequenceProgress(long start, long maxReceived, long maxMissing) {
        this.start = start;
        this.maxReceived = maxReceived;
        this.maxMissing = maxMissing;
    }

    public ProgressState initial() {
        return new ProgressState(start - 1, start - 1, null, null, false, List.of());
    }

    public ProgressState receive(ProgressState current, long sequence, long floor) {
        if (sequence < start) throw new ProgressRejected("beforeProgressStart");
        var ranges = new ArrayList<>(current.received());
        if (sequence > current.receivedThrough()) ranges.add(new ProgressState.Range(sequence, sequence));
        ranges.sort(Comparator.comparingLong(ProgressState.Range::from));
        var merged = new ArrayList<ProgressState.Range>();
        long prefix = current.receivedThrough();
        for (var range : ranges) {
            if (range.from() <= prefix + 1) {
                prefix = Math.max(prefix, range.through());
            } else if (!merged.isEmpty() && range.from() <= merged.getLast().through() + 1) {
                var previous = merged.removeLast();
                merged.add(new ProgressState.Range(previous.from(), Math.max(previous.through(), range.through())));
            } else {
                merged.add(range);
            }
        }
        boolean violated = current.sourceContractViolated()
                || current.watermarkThrough() != null && sequence <= current.watermarkThrough();
        var next = new ProgressState(prefix, Math.max(current.observedThrough(), sequence),
                current.watermarkThrough(), current.watermarkVersion(), violated, merged);
        bounds(next, floor);
        return next;
    }

    public ProgressState advance(ProgressState current, long through, long version, long floor) {
        if (through < start) throw new ProgressRejected("invalidProgress");
        if (current.watermarkThrough() != null && through < current.watermarkThrough()) {
            throw new ProgressRejected("backwardsWatermark");
        }
        var next = new ProgressState(current.receivedThrough(), Math.max(current.observedThrough(), through),
                through, version, current.sourceContractViolated(), current.received());
        bounds(next, floor);
        return next;
    }

    public List<ProgressState.Missing> missing(ProgressState current, long floor) {
        var result = new ArrayList<ProgressState.Missing>();
        long next = current.receivedThrough() + 1;
        for (var range : current.received()) {
            append(result, next, range.from() - 1, current.watermarkThrough(), floor);
            next = range.through() + 1;
        }
        append(result, next, current.observedThrough(), current.watermarkThrough(), floor);
        return List.copyOf(result);
    }

    private void append(List<ProgressState.Missing> result, long from, long through, Long watermark, long floor) {
        if (from > through) return;
        long expiredEnd = Math.min(through, floor - 1);
        if (from <= expiredEnd) {
            result.add(new ProgressState.Missing(from, expiredEnd, "expired"));
            from = expiredEnd + 1;
        }
        long confirmedEnd = watermark == null ? from - 1 : Math.min(through, watermark);
        if (from <= confirmedEnd) {
            result.add(new ProgressState.Missing(from, confirmedEnd, "confirmed"));
            from = confirmedEnd + 1;
        }
        if (from <= through) result.add(new ProgressState.Missing(from, through, "provisional"));
    }

    private void bounds(ProgressState current, long floor) {
        if (current.received().size() > maxReceived || missing(current, floor).size() > maxMissing) {
            throw new ProgressRejected("progressLimit");
        }
    }

    public void validate(ProgressState current, long floor, long version) {
        if (current == null || current.receivedThrough() < start - 1
                || current.observedThrough() < current.receivedThrough()
                || current.observedThrough() > PublicationJson.MAX_SEQUENCE
                || (current.watermarkThrough() == null) != (current.watermarkVersion() == null)
                || current.watermarkThrough() != null && (current.watermarkThrough() < start
                    || current.watermarkThrough() > current.observedThrough()
                    || current.watermarkVersion() <= 0 || current.watermarkVersion() > version)
                || current.sourceContractViolated() && current.watermarkThrough() == null) {
            throw new IllegalStateException("Invalid recovered progress");
        }
        long previous = current.receivedThrough();
        for (var range : current.received()) {
            if (range == null || range.from() <= previous + 1 || range.through() < range.from()
                    || range.through() > current.observedThrough()) {
                throw new IllegalStateException("Invalid recovered received ranges");
            }
            previous = range.through();
        }
        long expectedObserved = Math.max(previous, current.watermarkThrough() == null ? start - 1 : current.watermarkThrough());
        if (expectedObserved != current.observedThrough()) throw new IllegalStateException("Invalid observed boundary");
        bounds(current, floor);
    }
}
