package io.zooglass.delivery;

import io.zooglass.access.AdmissionAccess;
import io.zooglass.access.AccessGrant;
import io.zooglass.access.SnapshotAdmission;
import io.zooglass.access.ViewResource;
import io.zooglass.api.ViewSnapshot;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;

import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;

/** Keeps protected snapshot serialisation ahead of a nonblocking, grant-checked writer. */
@Component
public final class HttpSnapshotDelivery {

    private final AdmissionAccess access;
    private final SnapshotAdmission admission;
    private final JsonMapper json;

    public HttpSnapshotDelivery(AdmissionAccess access, SnapshotAdmission admission, JsonMapper json) {
        this.access = access;
        this.admission = admission;
        this.json = json;
    }

    public ResponseEntity<ViewSnapshot> read(HttpServletRequest request, HttpServletResponse response,
            String viewId, String entityId) throws IOException {
        var result = admission.read(request, viewId, entityId);
        if (!access.protectedMode() || !(request.getAttribute(SnapshotAdmission.GRANT) instanceof AccessGrant grant)) {
            return result;
        }
        byte[] body = result.getBody() == null ? new byte[0] : json.writeValueAsBytes(result.getBody());
        Runnable abort = HttpTransportAbort.forRequest(request);
        response.setHeader("Cache-Control", "no-store");
        var output = response.getOutputStream();
        var context = request.startAsync();
        // No HTTP renewal: a finite response must finish within its original grant.
        // A non-reading client cannot retain its snapshot indefinitely.
        context.setTimeout(5000);
        var writer = new AuthorisedHttpWriter(context, response, output, abort, grant,
                new ViewResource(viewId, entityId), result.getStatusCode().value(), body);
        context.addListener(writer);
        output.setWriteListener(writer);
        return null;
    }
}
