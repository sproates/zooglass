package io.zooglass.v2;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/** V2 uses separate endpoints; legacy sources and views are never reinterpreted. */
@RestController
public final class V2Endpoints implements WebSocketConfigurer {
    private final EventIngress ingress;
    private final ProgressIngress progress;
    private final FactRetirementIngress retirement;
    private final ViewCoordinator coordinator;

    public V2Endpoints(EventIngress ingress, ProgressIngress progress, FactRetirementIngress retirement, ViewCoordinator coordinator) {
        this.ingress = ingress;
        this.progress = progress;
        this.retirement = retirement;
        this.coordinator = coordinator;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(ingress, "/v2/events");
        registry.addHandler(progress, "/v2/progress");
        registry.addHandler(retirement, "/v2/facts/retire");
    }

    @GetMapping("/v2/views/{viewId}/{entityId}")
    public ResponseEntity<ViewCoordinator.Snapshot> snapshot(
            @PathVariable String viewId, @PathVariable String entityId) {
        return coordinator.snapshot(viewId, entityId).map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
