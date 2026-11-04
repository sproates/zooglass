package io.zooglass.v2;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static io.zooglass.v2.SourcePriorityTests.event;
import static org.assertj.core.api.Assertions.*;

class SourcePriorityFailureTests {
    @TempDir Path directory;

    @Test
    void laterCapacityFailureDiscardsBothVisibleAndHiddenCandidates() {
        var initial = SourcePriorityTests.configuration("memory");
        var views = new ArrayList<>(initial.views());
        views.add(new V2Configuration.View("history", Map.of("events",
                new V2Configuration.Field("backup", "updated", "historyBySequence"))));
        var config = new V2Configuration(2, "memory", 10, 1000, 1, initial.sources(), views);
        try (var runtime = new ViewCoordinator(config)) {
            runtime.apply(event("primary", 2));
            runtime.apply(event("backup", 900));
            assertThat(runtime.apply(event("backup", 901)).reason()).isEqualTo("historyLimit");
            assertThat(runtime.snapshot("backup-first", "order").orElseThrow().data().get("status")
                    .path("publicationSequence").longValue()).isEqualTo(900);
            assertThat(runtime.apply(event("backup", 901)).reason()).isEqualTo("historyLimit");
            assertThat(runtime.apply(event("primary", 3)).version()).isEqualTo(3);
        }
    }

    @Test
    void hiddenWriteFailureRollsBackReceiptAndCandidateTogether() throws Exception {
        Path file = directory.resolve("state.db");
        var initial = SourcePriorityTests.configuration("sqlite");
        var config = new V2Configuration(2, "sqlite", 10, 1000, 10, initial.sources(), List.of(initial.views().getFirst()));
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            runtime.apply(event("primary", 2));
            runtime.apply(event("backup", 900));
        }
        execute(file, "CREATE TRIGGER refuse_view BEFORE INSERT ON views BEGIN SELECT RAISE(ABORT,'test'); END");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            assertThatThrownBy(() -> runtime.apply(event("backup", 901))).isInstanceOf(IllegalStateException.class);
            assertThat(runtime.healthy()).isFalse();
        }
        execute(file, "DROP TRIGGER refuse_view");
        try (var runtime = new ViewCoordinator(config, file.toString())) {
            assertThat(runtime.snapshot("primary-first", "order").orElseThrow().version()).isEqualTo(2);
            assertThat(runtime.apply(event("backup", 900)).status()).isEqualTo("duplicate");
            assertThat(runtime.apply(event("backup", 901)).status()).isEqualTo("committed");
        }
    }

    @Test
    void recoveryRejectsDamagedHiddenCandidatesAndWrongSelectedWinner() throws Exception {
        int index = 0;
        for (String damage : List.of(
                "json_remove(state,'$.candidates')",
                "json_set(state,'$.candidates.status',json('{}'))",
                "json_set(state,'$.candidates.status.backup.provenance.sourceId','primary')",
                "json_set(state,'$.candidates.status.backup.provenance.sourceEntityId','wrong')",
                "json_set(state,'$.candidates.status.backup.provenance.epoch','wrong')",
                "json_set(state,'$.candidates.status.backup.value.publicationSequence',0)",
                "json_set(state,'$.candidates.status.backup.value.payload',json('[]'))",
                "json_remove(state,'$.candidates.status.primary')",
                "json_set(state,'$.data.status.publicationSequence',900)")) {
            Path file = directory.resolve("corrupt-" + index++ + ".db");
            var config = SourcePriorityTests.configuration("sqlite");
            try (var runtime = new ViewCoordinator(config, file.toString())) {
                runtime.apply(event("primary", 2));
                runtime.apply(event("backup", 900));
            }
            execute(file, "UPDATE views SET state=" + damage + " WHERE view='primary-first'");
            assertThatThrownBy(() -> new ViewCoordinator(config, file.toString())).as(damage)
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    private static void execute(Path file, String sql) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + file);
                var statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
