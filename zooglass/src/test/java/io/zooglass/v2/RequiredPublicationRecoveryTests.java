package io.zooglass.v2;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

class RequiredPublicationRecoveryTests {

    @TempDir Path directory;

    @Test
    void recoveryRejectsExposedWaitingValues() throws Exception {
        var file = directory.resolve("leak.db");
        var config = RequiredContributionTests.configuration("sqlite");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            runtime.apply(RequiredContributionTests.report("orders", "A", 1));
        }
        ProgressFailureTests.execute(
                file,
                """
                UPDATE views SET state=json_set(state,
                    '$.data.order', json_extract(state,'$.candidates.order.orders.value'),
                    '$.provenance.order', json_extract(state,'$.candidates.order.orders.provenance'))
                WHERE view='dispatch'
                """);
        assertThatThrownBy(() -> new ViewCoordinator(config, file.toString()))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void recoveryRejectsMorePendingRowsThanConfigured() throws Exception {
        var file = directory.resolve("capacity.db");
        var config = RequiredContributionTests.configuration("sqlite");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            runtime.apply(RequiredContributionTests.report("orders", "A", 1));
            runtime.apply(RequiredContributionTests.report("payments", "A", 1));
            runtime.apply(RequiredContributionTests.report("orders", "B", 1));
        }
        ProgressFailureTests.execute(
                file,
                """
                UPDATE views SET state=json_set(json_remove(state,'$.candidates.payment'),
                    '$.data',json('{}'),'$.provenance',json('{}'))
                WHERE view='dispatch' AND entity='A'
                """);
        assertThatThrownBy(() -> new ViewCoordinator(config, file.toString()))
                .isInstanceOf(IllegalStateException.class);
    }
}
