package io.zooglass.strategy.fact;

public final class FactProjectionSelection {

    private FactProjectionSelection() {}

    public static FactProjection select(String mode, String property) {
        if ("activeFacts".equals(mode) && property == null) {
            return new ActiveFacts();
        }
        if ("sumActiveFacts".equals(mode) && property != null && !property.isBlank()) {
            return new SumActiveFacts(property);
        }
        throw new IllegalArgumentException("Invalid fact projection or numeric property");
    }
}
