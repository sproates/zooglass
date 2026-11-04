package io.zooglass.strategy.freshness;

/** Durable receipt evidence. An unknown age has no usable timestamp. */
public record ReceiptAge(Long receivedAtMillis, String classification) {
    public static ReceiptAge unknown() { return new ReceiptAge(null, "ageUnknown"); }

    public ReceiptAge {
        boolean valid = switch (classification) {
            case "ageUnknown" -> receivedAtMillis == null;
            case "fresh", "stale" -> receivedAtMillis != null && receivedAtMillis >= 0;
            case null, default -> false;
        };
        if (!valid) {
            throw new IllegalArgumentException("Invalid receipt age");
        }
    }

    public ReceiptAge stale() { return new ReceiptAge(receivedAtMillis, "stale"); }
}
