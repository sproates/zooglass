package io.zooglass.strategy.contribution;

import com.fasterxml.jackson.annotation.JsonInclude;

import io.zooglass.strategy.freshness.ReceiptAge;
import io.zooglass.v2.Provenance;

import tools.jackson.databind.JsonNode;

/** One source's retained value and original identity. */
public record SelectedContribution(
        JsonNode value,
        Provenance provenance,
        @JsonInclude(JsonInclude.Include.NON_NULL) ReceiptAge age) {
    public SelectedContribution(JsonNode value, Provenance provenance) {
        this(value, provenance, null);
    }

    public SelectedContribution withAge(ReceiptAge age) {
        return new SelectedContribution(value, provenance, age);
    }
}
