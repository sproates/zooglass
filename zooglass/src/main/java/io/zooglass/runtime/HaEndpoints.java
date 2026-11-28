package io.zooglass.runtime;

import io.zooglass.access.*;
import io.zooglass.delivery.HttpSnapshotDelivery;
import io.zooglass.logging.ViewerLog;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ConcurrentHashMap;

@HaDeployment
@RestController
public final class HaEndpoints {
    static final String MEDIA = "application/vnd.zooglass.ha-v1+json";
    public static final String PROBE_DEADLINE = HaEndpoints.class.getName() + ".deadline";
    private final ConcurrentHashMap<Runnable, OwnedRuntime> outputs = new ConcurrentHashMap<>();
    private final HaOwner owner;
    private final AdmissionAccess access;
    private final HaSettings settings;
    private final OperatorAccess operator;

    HaEndpoints(HaOwner owner, AdmissionAccess access, HaSettings settings, OperatorAccess operator) {
        this.owner = owner;
        this.access = access;
        this.settings = settings;
        this.operator = operator;
        owner.onRetirement(retired -> outputs.forEach((abort, attempt) -> {
            if (attempt == retired && outputs.remove(abort, attempt)) Thread.startVirtualThread(abort);
        }));
    }

    @RequestMapping("/ha/ready")
    public void probe(HttpServletRequest request, HttpServletResponse response) {
        long deadline = request.getAttribute(PROBE_DEADLINE) instanceof Long value ? value : System.nanoTime();
        int status;
        if (operator.listener(request) || !request.isSecure()) status = 403;
        else if (!settings.permitsProbe(Collections.list(request.getHeaders("Authorization")))) status = 401;
        else if (!"GET".equals(request.getMethod())) {
            response.setHeader("Allow", "GET");
            status = 405;
        } else if (!"HTTP/1.1".equals(request.getProtocol())) status = 505;
        else status = owner.probe(deadline) ? 200 : 503;
        empty(response, status);
    }

    @GetMapping("/views")
    public void lookup(HttpServletRequest request, HttpServletResponse response) throws IOException {
        var params = request.getParameterMap();
        if (params.size() != 2 || !params.containsKey("viewId") || !params.containsKey("entityId")
                || params.values().stream().anyMatch(v -> v.length != 1)) {
            empty(response, 400);
            return;
        }
        snapshot(request, response, request.getParameter("viewId"), request.getParameter("entityId"));
    }

    static boolean negotiated(String accept) {
        if (accept == null) return false;
        try {
            return MediaType.parseMediaTypes(accept).stream().anyMatch(media ->
                    "application".equalsIgnoreCase(media.getType()) && "vnd.zooglass.ha-v1+json".equalsIgnoreCase(media.getSubtype())
                            && media.getQualityValue() > 0);
        } catch (IllegalArgumentException malformed) { return false; }
    }

    @GetMapping("/views/{viewId}/{entityId}")
    public void snapshot(HttpServletRequest request, HttpServletResponse response,
            @PathVariable String viewId, @PathVariable String entityId) throws IOException {
        response.setHeader("Vary", "Accept");
        var credential = access.credential(request, false);
        if (!"HTTP/1.1".equals(request.getProtocol())) { empty(response, 505); return; }
        if (!negotiated(String.join(",", Collections.list(request.getHeaders("Accept"))))) { empty(response, 406); return; }
        ViewResource resource;
        try { resource = new ViewResource(viewId, entityId); }
        catch (IllegalArgumentException invalid) { empty(response, 400); return; }
        var decision = access.authorise(credential, resource);
        if (decision instanceof AccessDecision.Rejected refused) {
            access.recordRejection(ViewerLog.Boundary.SNAPSHOT, refused.reason());
            empty(response, AdmissionAccess.status(refused));
            return;
        }
        var grant = decision instanceof AccessDecision.Granted allowed ? allowed.grant() : null;
        record Read(OwnedRuntime attempt, int status, String body) {}
        Read result;
        try {
            result = owner.use(null, attempt -> {
                if (grant != null && !grant.permits(resource)) return null;
                var frame = attempt.snapshotFrame(request, resource);
                return new Read(attempt, "notFound".equals(frame.kind()) ? 404 : 200, frame.admit(request));
            });
        } catch (StorageUnavailable unavailable) { empty(response, 503); return; }
        if (result == null) { empty(response, 503); return; }
        HttpSnapshotDelivery.send(request, response, result.status(), result.body().getBytes(StandardCharsets.UTF_8),
                MEDIA, () -> owner.current(result.attempt()) && (grant == null || grant.permits(resource)),
                abort -> {
                    outputs.put(abort, result.attempt());
                    if (!owner.current(result.attempt()) && outputs.remove(abort, result.attempt())) Thread.startVirtualThread(abort);
                    return () -> outputs.remove(abort, result.attempt());
                });
    }

    @PostMapping("/views")
    public void immutable(HttpServletResponse response) {
        response.setHeader("Allow", "GET");
        empty(response, 405);
    }

    @GetMapping({"/progress", "/facts/retire"})
    public void absent(HttpServletResponse response) { empty(response, 404); }

    private static void empty(HttpServletResponse response, int status) {
        response.setHeader("Cache-Control", "no-store");
        response.setStatus(status);
        response.setContentLength(0);
    }
}
