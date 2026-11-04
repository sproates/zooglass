package io.zooglass.strategy.freshness;

public record ReceiptAgeFreshness(long staleAfterMillis) implements FreshnessStrategy {
    public ReceiptAge received(long wallMillis) {
        return new ReceiptAge(wallMillis, "fresh");
    }

    public ReceiptAge recovered(ReceiptAge saved, long wallMillis, boolean clockWentBack) {
        if (saved == null || saved.receivedAtMillis() == null || saved.hasUncertainClock() || clockWentBack || wallMillis < saved.receivedAtMillis()) {
            return ReceiptAge.unknown();
        }
        return wallMillis - saved.receivedAtMillis() >= staleAfterMillis ? saved.stale() : saved;
    }

    public Long remaining(ReceiptAge age, long elapsedMillis) {
        if (age == null || !"fresh".equals(age.classification())) return null;
        return Math.max(0, staleAfterMillis - elapsedMillis);
    }
}
