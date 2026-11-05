package io.zooglass.strategy.freshness;

public final class UnspecifiedFreshness implements FreshnessStrategy {

    public ReceiptAge received(long wallMillis) {
        return null;
    }

    public ReceiptAge recovered(ReceiptAge saved, long wallMillis, boolean clockWentBack) {
        if (saved != null) {
            throw new IllegalStateException("Unexpected receipt age for unspecified field");
        }
        return null;
    }

    public Long remaining(ReceiptAge age, long elapsedMillis) {
        return null;
    }
}
