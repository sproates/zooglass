package io.zooglass.access;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;

class ViewerCredentialTests {

    @Test
    void selectsOnlyOneOpaqueCredentialAndRedactsItsDisplay() {
        var bearer = ViewerCredential.read(List.of("bearer abc/+=="), List.of("other=ignored"), "session");
        assertThat(bearer.kind()).isEqualTo(ViewerCredential.Kind.BEARER);
        assertThat(bearer.value()).isEqualTo("abc/+==");
        assertThat(bearer.toString()).doesNotContain("abc/+");
        var cookie = ViewerCredential.read(List.of(), List.of("other=a; session=opaque-token; x=y"), "session");
        assertThat(cookie.kind()).isEqualTo(ViewerCredential.Kind.SESSION);
        assertThat(cookie.value()).isEqualTo("opaque-token");
        assertThat(cookie.toString()).doesNotContain("opaque-token");
        assertThat(ViewerCredential.read(List.of(), List.of("other=a"), "session")).isNull();
    }

    @Test
    void duplicateHeadersCookiesAndMixedCredentialsAreRejected() {
        for (var headers : List.of(List.of("Bearer a", "Bearer b"), List.of("Bearer a, Bearer b"))) {
            assertThatThrownBy(() -> ViewerCredential.read(headers, List.of(), "session"))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        for (var cookies : List.of(List.of("session=a; session=b"), List.of("session=a", "session=b"))) {
            assertThatThrownBy(() -> ViewerCredential.read(List.of(), cookies, "session"))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> ViewerCredential.read(List.of("Bearer a"), List.of("session=b"), "session"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "Basic abc", "Bearer ", "Bearer a b", "Bearer a\r\nb", "Bearer abc=def"})
    void invalidBearerHeadersDoNotAppearInErrors(String header) {
        assertThatThrownBy(() -> ViewerCredential.read(List.of(header), List.of(), "session"))
                .hasMessage("Missing, ambiguous or invalid viewer credential");
    }

    @ParameterizedTest
    @ValueSource(strings = {"session", "session=", "session=\"quoted\"", "session=a b"})
    void rejectsMalformedSessionCookies(String cookie) {
        assertThatThrownBy(() -> ViewerCredential.read(List.of(), List.of(cookie), "session"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void boundsCredentialsAndValidatesCookieName() {
        assertThatThrownBy(() -> ViewerCredential.read(List.of("Bearer " + "a".repeat(4097)), List.of(), "session"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ViewerCredential.read(List.of(), List.of(), "bad name"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
