package io.zooglass.access;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import static org.assertj.core.api.Assertions.*;

class OperatorBoundaryTests {
    private final OperatorAccess operator = new OperatorAccess(ProtectedSettingsTests.valid());
    private final String token = "Bearer synthetic-operator-token-0123456789";

    @Test
    void forwardingHeadersAndForeignMarkersCannotSelectTheOperatorRole() {
        var request = new MockHttpServletRequest("GET", "/events");
        request.addHeader("Authorization", token);
        request.addHeader("X-Forwarded-Port", "9091");
        request.addHeader("X-Forwarded-For", "127.0.0.1");
        request.setLocalPort(9091);
        assertThat(operator.permits(request)).isFalse();
        request.setAttribute(OperatorAccess.LISTENER, new OperatorAccess(ProtectedSettingsTests.valid()));
        assertThat(operator.permits(request)).isFalse();
        request.setAttribute(OperatorAccess.LISTENER, operator);
        assertThat(operator.permits(request)).isTrue();
    }

    @Test
    void localListenerStillRequiresOneCorrectTokenAndRefusesBrowserOrigins() {
        var request = new MockHttpServletRequest();
        request.setAttribute(OperatorAccess.LISTENER, operator);
        assertThat(operator.permits(request)).isFalse();
        request.addHeader("Authorization", "Bearer viewer-token");
        assertThat(operator.permits(request)).isFalse();
        request.removeHeader("Authorization");
        request.addHeader("Authorization", token);
        request.addHeader("Authorization", token);
        assertThat(operator.permits(request)).isFalse();
        request.removeHeader("Authorization");
        request.addHeader("Authorization", token);
        request.addHeader("Origin", AdmissionBoundaryTests.ORIGIN);
        assertThat(operator.permits(request)).isFalse();
    }

    @Test
    void operatorBoundaryDoesNotReachViewerPolicyAndRejectsViewerAndOtherManagementRoutes() throws Exception {
        var access = AdmissionBoundaryTests.access((credential, resource) -> {
            throw new AssertionError("An operator must not use viewer policy");
        });
        var filter = new ViewerBoundaryFilter(access, operator);
        for (String path : new String[] {"/views", "/views/match/42", "/views/live", "/actuator/env"}) {
            var request = new MockHttpServletRequest("GET", path);
            request.setServletPath(path);
            request.setAttribute(OperatorAccess.LISTENER, operator);
            request.addHeader("Authorization", token);
            var response = new MockHttpServletResponse();
            filter.doFilter(request, response, (req, res) -> { throw new AssertionError("Viewer route reached"); });
            assertThat(response.getStatus()).as(path).isEqualTo(403);
        }
    }
}
