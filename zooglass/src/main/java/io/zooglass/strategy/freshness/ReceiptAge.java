package io.zooglass.strategy.freshness;

import com.fasterxml.jackson.annotation.JsonInclude;

/** Durable receipt evidence. An unknown age has no usable timestamp. */
public record ReceiptAge(Long receivedAtMillis, String classification,
        @JsonInclude(JsonInclude.Include.NON_NULL)
        Boolean uncertainOnRestart) {
    public ReceiptAge(Long receivedAtMillis, String classification) { this(receivedAtMillis, classification, null); }

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

    public boolean hasUncertainClock() { return Boolean.TRUE.equals(uncertainOnRestart); }

    public ReceiptAge stale() { return new ReceiptAge(receivedAtMillis, "stale", uncertainOnRestart); }
}
