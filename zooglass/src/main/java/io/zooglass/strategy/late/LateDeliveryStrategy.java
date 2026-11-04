package io.zooglass.strategy.late;

public interface LateDeliveryStrategy {
    boolean accepts(long sequence, Long watermark);
}
