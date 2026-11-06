package io.zooglass.runtime;

import io.zooglass.api.ViewSnapshot;
import io.zooglass.access.AdmissionAccess;
import io.zooglass.access.SnapshotAdmission;
import io.zooglass.access.ViewerHandshake;

import jakarta.servlet.http.HttpServletRequest;
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
    private final AdmissionAccess access;
    private final SnapshotAdmission reads;
    private final EventIngress ingress;
    private final ProgressIngress progress;
    private final FactRetirementIngress retirement;
    private final ViewCoordinator coordinator;

    public RuntimeEndpoints(
            SnapshotSubscriptions live,
            EventIngress ingress,
            ProgressIngress progress,
            FactRetirementIngress retirement,
            ViewCoordinator coordinator, AdmissionAccess access, SnapshotAdmission reads) {
        this.live = live;
        this.access = access;
        this.reads = reads;
        this.ingress = ingress;
        this.progress = progress;
        this.retirement = retirement;
        this.coordinator = coordinator;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        if (!access.protectedMode()) {
            registry.addHandler(ingress, "/events");
            registry.addHandler(progress, "/progress");
            registry.addHandler(retirement, "/facts/retire");
        }
        var viewers = registry.addHandler(live, "/views/live")
                .addInterceptors(new ViewerHandshake(access));
        if (access.protectedMode()) {
            viewers.setAllowedOrigins(access.origin());
        }
    }

    @PostMapping("/views")
    public ResponseEntity<Void> define(@RequestBody String body) {
        if (access.protectedMode()) {
            return ResponseEntity.status(403).build();
        }
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
            @RequestParam String viewId, @RequestParam String entityId, HttpServletRequest request) {
        return reads.read(request, viewId, entityId);
    }

    @GetMapping("/views/{viewId}/{entityId}")
    public ResponseEntity<ViewSnapshot> snapshot(
            @PathVariable String viewId, @PathVariable String entityId, HttpServletRequest request) {
        return reads.read(request, viewId, entityId);
    }
}
