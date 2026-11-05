package io.zooglass.strategy.late;

public final class LateStrategySelection {

    private LateStrategySelection() {}

    public static LateDeliveryStrategy select(String mode) {
        return switch (mode) {
            case "acceptLate" -> new AcceptLate();
            case "rejectBehindWatermark" -> new RejectBehindWatermark();
            case null -> throw new IllegalArgumentException("Late delivery mode is required");
            default -> throw new IllegalArgumentException("Unknown late delivery strategy");
        };
    }
}
