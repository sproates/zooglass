package io.zooglass.strategy.contribution;

import io.zooglass.v2.Provenance;
import tools.jackson.databind.JsonNode;

/** One source's retained value and original identity. */
public record SelectedContribution(JsonNode value, Provenance provenance) {}
