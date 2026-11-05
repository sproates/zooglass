package io.zooglass.strategy.late;

/** Identity retention is enforced before this policy runs. */
public final class AcceptLate implements LateDeliveryStrategy {

    public boolean accepts(long sequence, Long watermark) {
        return true;
    }
}
