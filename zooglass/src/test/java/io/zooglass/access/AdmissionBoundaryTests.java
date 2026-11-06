package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;

import java.util.HashMap;
import java.util.concurrent.atomic.AtomicBoolean;

class AdmissionBoundaryTests {

    static final String ORIGIN = "https://viewer.example";

    static AdmissionAccess access(PolicyClient client) {
        return new AdmissionAccess(new ApplicationPolicyAccess("tenant-a", client, System::nanoTime),
                "tenant-a", ORIGIN, "session");
    }

    static MockHttpServletRequest request() {
        var request = new MockHttpServletRequest("GET", "/views/live");
        request.setServletPath("/views/live");
        request.setSecure(true);
        request.setAttribute("jakarta.servlet.request.cipher_suite", "TLS_AES_128_GCM_SHA256");
        request.addHeader("Authorization", "Bearer viewer-token");
        return request;
    }

    static PolicyReply allow() {
        return new PolicyReply(PolicyReply.Outcome.ALLOW, "operator", 5000);
    }

    @ParameterizedTest
    @ValueSource(strings = {"applicationPolicy", "typo", ""})
    void startupCannotEnableProtectedOrUnknownModes(String mode) {
        assertThatThrownBy(() -> new AdmissionAccess(new MockEnvironment()
                .withProperty("zooglass.access.mode", mode))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void policySettingsCannotBeSilentlyIgnoredInOpenMode() {
        assertThatThrownBy(() -> new AdmissionAccess(new MockEnvironment()
                .withProperty("zooglass.access.tenant", "tenant-a")))
                .hasMessage("Open demo access cannot have protected access settings");
        var open = new AdmissionAccess(new MockEnvironment());
        assertThat(open.protectedMode()).isFalse();
        assertThat(open.authorise(null, AccessStrategyTests.ORDER)).isInstanceOf(AccessDecision.Open.class);
        open.close();
    }

    @Test
    void forwardingHeadersAndSecureFlagCannotStandInForConnectorTls() {
        var access = access((credential, resource) -> allow());
        var request = request();
        request.removeAttribute("jakarta.servlet.request.cipher_suite");
        request.addHeader("X-Forwarded-Proto", "https");
        request.addHeader("Forwarded", "proto=https");
        assertThatThrownBy(() -> access.credential(request, true)).isInstanceOfSatisfying(
                AccessRefused.class, refused -> assertThat(refused.status()).isEqualTo(403));
        request.setAttribute("jakarta.servlet.request.cipher_suite", "cipher");
        request.setSecure(false);
        assertThatThrownBy(() -> access.credential(request, true)).isInstanceOf(AccessRefused.class);
    }

    @Test
    void sessionHandshakeRequiresOneAllowedOrigin() {
        var access = access((credential, resource) -> allow());
        var request = request();
        request.removeHeader("Authorization");
        request.addHeader("Cookie", "session=opaque");
        assertThatThrownBy(() -> access.credential(request, true)).isInstanceOf(AccessRefused.class);
        request.addHeader("Origin", ORIGIN);
        assertThat(access.credential(request, true).kind()).isEqualTo(ViewerCredential.Kind.SESSION);
        request.addHeader("Origin", ORIGIN);
        assertThatThrownBy(() -> access.credential(request, true)).isInstanceOf(AccessRefused.class);
        request.removeHeader("Origin");
        request.addHeader("Origin", "https://other.example");
        assertThatThrownBy(() -> access.credential(request, true)).isInstanceOf(AccessRefused.class);
    }

    @Test
    void handshakeDistinguishesFailuresAndRetainsOnlyAuthenticatedIdentity() {
        for (var outcome : PolicyReply.Outcome.values()) {
            var access = access((credential, resource) -> outcome == PolicyReply.Outcome.ALLOW
                    ? allow() : new PolicyReply(outcome, null, 0));
            var response = new MockHttpServletResponse();
            var attributes = new HashMap<String, Object>();
            boolean accepted = new ViewerHandshake(access).beforeHandshake(
                    new ServletServerHttpRequest(request()), new ServletServerHttpResponse(response), null, attributes);
            if (outcome == PolicyReply.Outcome.ALLOW) {
                assertThat(accepted).isTrue();
                assertThat(((ViewerHandshake.Identity) attributes.get(ViewerHandshake.IDENTITY)).subject())
                        .isEqualTo("operator");
            } else {
                assertThat(accepted).isFalse();
                assertThat(attributes).isEmpty();
                assertThat(response.getStatus()).isEqualTo(switch (outcome) {
                    case UNAUTHENTICATED -> 401;
                    case DENY -> 403;
                    default -> 503;
                });
            }
        }
    }

    @Test
    void protectedListenerBlocksOperatorAndManagementRoutesWithoutCallingPolicy() throws Exception {
        var called = new AtomicBoolean();
        var filter = new ViewerBoundaryFilter(access((credential, resource) -> {
            called.set(true);
            return allow();
        }));
        for (String path : new String[] {"/events", "/progress", "/facts/retire", "/actuator/health"}) {
            var request = request();
            request.setServletPath(path);
            var response = new MockHttpServletResponse();
            filter.doFilter(request, response, (req, res) -> { throw new AssertionError("Route reached"); });
            assertThat(response.getStatus()).isEqualTo(403);
            assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
        }
        var request = request();
        request.setMethod("POST");
        request.setServletPath("/views");
        var response = new MockHttpServletResponse();
        filter.doFilter(request, response, (req, res) -> { throw new AssertionError("Registration reached"); });
        assertThat(response.getStatus()).isEqualTo(403);
        assertThat(called).isFalse();
    }
}
