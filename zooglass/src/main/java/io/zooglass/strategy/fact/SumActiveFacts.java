package io.zooglass.strategy.fact;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;

import java.math.BigDecimal;
import java.util.Map;

/** Exact sum of a top-level numeric property across the active records. */
public final class SumActiveFacts implements FactProjection {

    private final String property;

    SumActiveFacts(String property) {
        this.property = property;
    }

    @Override
    public void validatePayload(JsonNode payload) {
        contribution(payload);
    }

    @Override
    public JsonNode project(Map<Long, FactRecord> records) {
        var total = BigDecimal.ZERO;
        for (var record : records.values()) {
            if (record.active()) {
                total = total.add(contribution(record.payload()));
            }
        }
        var result = bounded(total);
        if (result.scale() > 0) {
            return JsonNodeFactory.instance.numberNode(result);
        }

        // Use the same integer node types that reading the persisted JSON will produce.
        var integer = result.toBigIntegerExact();
        if (integer.bitLength() < Integer.SIZE) {
            return JsonNodeFactory.instance.numberNode(integer.intValue());
        }
        if (integer.bitLength() < Long.SIZE) {
            return JsonNodeFactory.instance.numberNode(integer.longValue());
        }
        return JsonNodeFactory.instance.numberNode(integer);
    }

    private BigDecimal contribution(JsonNode payload) {
        var number = payload.path(property);
        if (!number.isNumber()) {
            throw new InvalidContribution("invalidNumericContribution");
        }
        return bounded(number.decimalValue());
    }

    private static BigDecimal bounded(BigDecimal value) {
        if (value.signum() == 0) {
            return BigDecimal.ZERO;
        }
        long integerPlaces = (long) value.precision() - value.scale();
        if (integerPlaces > 38) {
            throw new InvalidContribution("numericRange");
        }

        var normalized = value.stripTrailingZeros();
        if (normalized.precision() > 38 || normalized.scale() > 18) {
            throw new InvalidContribution("numericRange");
        }
        return normalized;
    }

    public static final class InvalidContribution extends RuntimeException {

        private InvalidContribution(String reason) {
            super(reason);
        }
    }
}
