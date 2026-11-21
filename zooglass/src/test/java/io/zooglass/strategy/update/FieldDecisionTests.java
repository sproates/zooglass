package io.zooglass.strategy.update;

import static io.zooglass.strategy.update.FieldUpdate.Reason.*;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

import tools.jackson.databind.json.JsonMapper;

class FieldDecisionTests {
    @Test
    void everyStrategyBranchSuppliesItsOwnReason() {
        var mapper = new JsonMapper();
        var one = mapper.readTree("{\"sequence\":1}");
        var two = mapper.readTree("{\"sequence\":2}");
        var missing = mapper.readTree("{}");
        var arrival = FieldStrategySelection.select("arrival", "sequence");
        var latest = FieldStrategySelection.select("latestBySequence", "sequence");
        var history = FieldStrategySelection.select("historyBySequence", "sequence");
        assertThat(arrival.evaluate(one, one).reason()).isEqualTo(ARRIVAL_REPLACED);
        assertThat(latest.evaluate(null, one).reason()).isEqualTo(LATEST_INITIAL);
        assertThat(latest.evaluate(one, two).reason()).isEqualTo(LATEST_NEWER);
        assertThat(latest.evaluate(two, one).reason()).isEqualTo(LATEST_OLDER);
        assertThat(latest.evaluate(one, one).reason()).isEqualTo(LATEST_EQUAL);
        assertThat(latest.evaluate(one, missing).reason()).isEqualTo(SEQUENCE_MISSING);
        var inserted = history.evaluate(null, one);
        assertThat(inserted.reason()).isEqualTo(HISTORY_INSERTED);
        assertThat(history.evaluate(inserted.replacement(), one).reason())
                .isEqualTo(HISTORY_EXISTING);
        assertThat(history.evaluate(inserted.replacement(), missing).reason())
                .isEqualTo(SEQUENCE_MISSING);
    }
}
