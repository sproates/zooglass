package io.zooglass.strategy.progress;

import java.util.List;

public interface ProgressStrategy {
    ProgressState initial();
    ProgressState receive(ProgressState current, long sequence, long floor);
    ProgressState advance(ProgressState current, long through, long version, long floor);
    List<ProgressState.Missing> missing(ProgressState current, long floor);
    void validate(ProgressState current, long floor, long version);
}
