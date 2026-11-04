package io.zooglass.strategy.progress;

import io.zooglass.v2.PublicationJson;

public final class ProgressStrategySelection {
    private ProgressStrategySelection() {}

    public static ProgressStrategy select(String mode, Long start, Long received, Long missing) {
        if ("untracked".equals(mode) && start == null && received == null && missing == null) {
            return new UntrackedProgress();
        }
        if ("contiguousSequence".equals(mode) && positive(start) && positive(received) && positive(missing)) {
            return new ContiguousSequenceProgress(start, received, missing);
        }
        throw new IllegalArgumentException("Invalid progress strategy settings");
    }

    private static boolean positive(Long value) {
        return value != null && value > 0 && value <= PublicationJson.MAX_SEQUENCE;
    }
}
