package io.zooglass.runtime;

import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

/** The parity suite observes only the checked immutable handoffs from the actual owner. */
final class AdmittedPostgresRuntime implements AutoCloseable {
    private final OwnedRuntime owner;

    AdmittedPostgresRuntime(HaStaticProfile profile, PostgresState.Connections connections) {
        owner = ViewCoordinator.postgres(profile, connections, Duration.ofSeconds(30));
        try {
            owner.recover();
            owner.activate();
        } catch (RuntimeException failure) {
            owner.close();
            throw failure;
        }
    }

    PublicationOutcome apply(Publication publication) {
        var response = owner.publish(publication);
        return read(response.receipt(), PublicationOutcome.class);
    }

    Optional<ViewCoordinator.Snapshot> snapshot(String view, String entity) {
        return Optional.ofNullable(read(owner.snapshot(view, entity), ViewCoordinator.Snapshot.class));
    }

    ProgressOutcome advance(ProgressControl control) {
        return read(owner.advance(control), ProgressOutcome.class);
    }

    FactRetirementOutcome retire(FactRetirement control) {
        return read(owner.retire(control), FactRetirementOutcome.class);
    }

    private <T> T read(OwnedRuntime.Content content, Class<T> type) {
        var result = new AtomicReference<T>();
        owner.handoff(content, admitted -> result.set(StateRowJson.JSON.readValue(admitted.body(), type)));
        return result.get();
    }

    @Override
    public void close() { owner.close(); }
}
