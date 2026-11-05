package io.zooglass.strategy.progress;

import java.util.List;

/** Sequence values have no completeness meaning without a declared source promise. */
public final class UntrackedProgress implements ProgressStrategy {

    public ProgressState initial() {
        return null;
    }

    public ProgressState receive(ProgressState current, long sequence, long floor) {
        return null;
    }

    public ProgressState advance(ProgressState current, long through, long version, long floor) {
        throw new ProgressRejected("progressUntracked");
    }

    public List<ProgressState.Missing> missing(ProgressState current, long floor) {
        return List.of();
    }

    public void validate(ProgressState current, long floor, long version) {
        if (current != null) {
            throw new IllegalStateException("Untracked stream has progress state");
        }
    }
}
