package io.zooglass.strategy.late;

public final class RejectBehindWatermark implements LateDeliveryStrategy {
    public boolean accepts(long sequence, Long watermark) {
        return watermark == null || sequence > watermark;
    }
}
