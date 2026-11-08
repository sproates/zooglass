package io.zooglass.access;

import io.zooglass.api.ViewSnapshot;
import io.zooglass.runtime.ViewCoordinator;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;

/** Authorises before lookup. HttpSnapshotDelivery checks the grant again at chunk release. */
@Component
public final class SnapshotAdmission {

    public static final String GRANT = SnapshotAdmission.class.getName() + ".grant";
    private final AdmissionAccess access;
    private final ViewCoordinator coordinator;

    public SnapshotAdmission(AdmissionAccess access, ViewCoordinator coordinator) {
        this.access = access;
        this.coordinator = coordinator;
    }

    public ResponseEntity<ViewSnapshot> read(HttpServletRequest request, String viewId, String entityId) {
        var credential = access.credential(request, false);
        ViewResource resource;
        try {
            resource = new ViewResource(viewId, entityId);
        } catch (IllegalArgumentException invalid) {
            return response(400, null);
        }
        var decision = access.authorise(credential, resource);
        if (decision instanceof AccessDecision.Rejected rejected) {
            return response(AdmissionAccess.status(rejected), null);
        }
        var snapshot = coordinator.snapshot(viewId, entityId).map(ViewSnapshot::from);
        if (decision instanceof AccessDecision.Granted allowed) {
            if (!allowed.grant().permits(resource)) {
                return response(503, null);
            }
            request.setAttribute(GRANT, allowed.grant());
        }
        return response(snapshot.isPresent() ? 200 : 404, snapshot.orElse(null));
    }

    private ResponseEntity<ViewSnapshot> response(int status, ViewSnapshot snapshot) {
        var builder = ResponseEntity.status(status);
        if (access.protectedMode()) {
            builder.header("Cache-Control", "no-store");
        }
        return builder.body(snapshot);
    }
}
