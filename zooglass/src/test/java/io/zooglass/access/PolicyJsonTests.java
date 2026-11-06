package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.util.List;

class PolicyJsonTests {

    @Test
    void sendsTheConfiguredTenantCredentialAndExactResourceWithoutClientSuppliedSubject() {
        var request = new JsonMapper().readTree(PolicyJson.request("tenant-a",
                AccessStrategyTests.CREDENTIAL, new ViewResource("orders", "a/b")));
        assertThat(request.size()).isEqualTo(4);
        assertThat(request.path("operation").asText()).isEqualTo("read");
        assertThat(request.path("tenant").asText()).isEqualTo("tenant-a");
        assertThat(request.path("credential").path("type").asText()).isEqualTo("bearer");
        assertThat(request.path("credential").path("value").asText()).isEqualTo("caller-token");
        assertThat(request.path("resource").path("entityId").asText()).isEqualTo("a/b");
        var identity = new JsonMapper().readTree(PolicyJson.request("tenant-a",
                ViewerCredential.read(List.of(), List.of("session=opaque"), "session"), null));
        assertThat(identity.size()).isEqualTo(3);
        assertThat(identity.path("operation").asText()).isEqualTo("authenticate");
        assertThat(identity.has("resource")).isFalse();
        assertThat(identity.path("credential").path("type").asText()).isEqualTo("session");
    }

    @Test
    void decodesOnlyTheThreeDefinedDecisions() {
        assertThat(reply("{\"decision\":\"allow\",\"subject\":\"operator\",\"lifetimeMillis\":5000}"))
                .isEqualTo(new PolicyReply(PolicyReply.Outcome.ALLOW, "operator", 5000));
        assertThat(reply("{\"decision\":\"deny\"}").outcome()).isEqualTo(PolicyReply.Outcome.DENY);
        assertThat(reply("{\"decision\":\"unauthenticated\"}").outcome())
                .isEqualTo(PolicyReply.Outcome.UNAUTHENTICATED);
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "", "null", "[]", "{}", "{", "{\"decision\":true}",
        "{\"decision\":\"allow\"}",
        "{\"decision\":\"deny\",\"subject\":\"operator\"}",
        "{\"decision\":\"deny\",\"decision\":\"allow\"}",
        "{\"decision\":\"deny\"} {}",
        "{\"decision\":\"unknown\"}",
        "{\"decision\":\"allow\",\"subject\":42,\"lifetimeMillis\":5000}",
        "{\"decision\":\"allow\",\"subject\":\" \",\"lifetimeMillis\":5000}",
        "{\"decision\":\"allow\",\"subject\":\"a\",\"lifetimeMillis\":\"5000\"}",
        "{\"decision\":\"allow\",\"subject\":\"a\",\"lifetimeMillis\":1.5}",
        "{\"decision\":\"allow\",\"subject\":\"a\",\"lifetimeMillis\":0}",
        "{\"decision\":\"allow\",\"subject\":\"a\",\"lifetimeMillis\":-1}",
        "{\"decision\":\"allow\",\"subject\":\"a\",\"lifetimeMillis\":9223372036854775808}",
        "{\"decision\":\"allow\",\"subject\":\"a\",\"lifetimeMillis\":1,\"extra\":true}"
    })
    void malformedRepliesAreUnavailable(String body) {
        assertThat(reply(body)).isEqualTo(PolicyReply.unavailable());
    }

    private PolicyReply reply(String body) {
        return PolicyJson.response(body.getBytes(StandardCharsets.UTF_8));
    }
}
