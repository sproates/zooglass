package io.zooglass.runtime;

import java.util.List;

public record ProgressOutcome(
        String kind,
        String status,
        String reason,
        Publication.StreamKey stream,
        Long throughSequence,
        Long version,
        List<String> changedViews) {
    public ProgressOutcome(
            String status,
            String reason,
            ProgressControl control,
            Long version,
            List<String> changedViews) {
        this(
                "watermark",
                status,
                reason,
                control == null ? null : control.stream(),
                control == null ? null : control.throughSequence(),
                version,
                List.copyOf(changedViews));
    }
}
