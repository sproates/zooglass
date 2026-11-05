package io.zooglass.strategy.freshness;

public final class FreshnessStrategySelection {

    private FreshnessStrategySelection() {}

    public static FreshnessStrategy select(String mode, Long staleAfterMillis) {
        if ("unspecified".equals(mode) && staleAfterMillis == null) {
            return new UnspecifiedFreshness();
        }
        if ("receiptAge".equals(mode)
                && staleAfterMillis != null
                && staleAfterMillis > 0
                && staleAfterMillis <= 9007199254740991L) {
            return new ReceiptAgeFreshness(staleAfterMillis);
        }
        throw new IllegalArgumentException("Invalid field freshness policy");
    }
}
