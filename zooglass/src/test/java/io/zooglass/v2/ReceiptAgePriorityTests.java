package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import java.util.Map;

import static io.zooglass.v2.SourcePriorityTests.event;
import static org.assertj.core.api.Assertions.assertThat;

class ReceiptAgePriorityTests {
    @Test
    void refreshingTheBackupDoesNotRefreshOrDisplaceThePrimary() {
        var original = SourcePriorityTests.configuration("memory");
        var views = original.views().stream().map(view -> {
            var field = view.fields().get("status");
            var timed = new V2Configuration.Field(null, null, field.mode(), field.inputs(), field.conflict(), field.late(),
                    new V2Configuration.Freshness("receiptAge", 5000L));
            return new V2Configuration.View(view.id(), Map.of("status", timed), view.entities());
        }).toList();
        var config = new V2Configuration(2, "memory", 10, 1000, 10, original.sources(), views);
        var clock = new ReceiptAgeTests.Clock();
        try (var service = new ViewCoordinator(config, "", clock)) {
            service.apply(event("primary", 1));
            clock.advance(3000);
            service.apply(event("backup", 100));
            clock.advance(2000);
            var primary = service.snapshot("primary-first", "order").orElseThrow();
            var backup = service.snapshot("backup-first", "order").orElseThrow();
            assertThat(primary.status().fields().get("status").freshness()).isEqualTo("stale");
            assertThat(primary.provenance().get("status").sourceId()).isEqualTo("primary");
            assertThat(backup.status().fields().get("status").freshness()).isEqualTo("fresh");
            service.apply(event("backup", 101));
            assertThat(service.snapshot("primary-first", "order").orElseThrow()).isEqualTo(primary);
        }
    }
}
