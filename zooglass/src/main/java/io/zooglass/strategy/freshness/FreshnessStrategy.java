package io.zooglass.strategy.freshness;

public interface FreshnessStrategy {
    ReceiptAge received(long wallMillis);
    ReceiptAge recovered(ReceiptAge saved, long wallMillis, boolean clockWentBack);
    Long remaining(ReceiptAge age, long elapsedMillis);
}
