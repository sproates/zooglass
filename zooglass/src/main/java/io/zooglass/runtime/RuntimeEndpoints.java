package io.zooglass.runtime;

import io.zooglass.api.ViewSnapshot;
import io.zooglass.delivery.SnapshotSubscriptions;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/** The single publication, control, snapshot and subscription API. */
@RestController
public final class RuntimeEndpoints implements WebSocketConfigurer {

    private final SnapshotSubscriptions live;
    private final EventIngress ingress;
    private final ProgressIngress progress;
    private final FactRetirementIngress retirement;
    private final ViewCoordinator coordinator;

    public RuntimeEndpoints(
            SnapshotSubscriptions live,
            EventIngress ingress,
            ProgressIngress progress,
            FactRetirementIngress retirement,
            ViewCoordinator coordinator) {
        this.live = live;
        this.ingress = ingress;
        this.progress = progress;
        this.retirement = retirement;
        this.coordinator = coordinator;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(ingress, "/events");
        registry.addHandler(live, "/views/live");
        registry.addHandler(progress, "/progress");
        registry.addHandler(retirement, "/facts/retire");
    }

    @PostMapping("/views")
    public ResponseEntity<Void> define(@RequestBody String body) {
        RuntimeConfiguration.View definition;
        try {
            definition = RuntimeConfiguration.parseView(body);
        } catch (RuntimeException invalid) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return ResponseEntity.status(coordinator.define(definition) ? 201 : 409).build();
        } catch (IllegalArgumentException invalid) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/views")
    public ResponseEntity<ViewSnapshot> lookup(
            @RequestParam String viewId, @RequestParam String entityId) {
        return snapshot(viewId, entityId);
    }

    @GetMapping("/views/{viewId}/{entityId}")
    public ResponseEntity<ViewSnapshot> snapshot(
            @PathVariable String viewId, @PathVariable String entityId) {
        return coordinator
                .snapshot(viewId, entityId)
                .map(ViewSnapshot::from)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
