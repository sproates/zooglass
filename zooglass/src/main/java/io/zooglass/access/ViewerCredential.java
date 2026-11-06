package io.zooglass.access;

import java.util.List;

/** An opaque credential held only for policy calls. Never include its value in diagnostics. */
public final class ViewerCredential {

    public enum Kind { BEARER, SESSION }

    private final Kind kind;
    private final String value;

    private ViewerCredential(Kind kind, String value) {
        this.kind = kind;
        this.value = value;
    }

    public Kind kind() {
        return kind;
    }

    String value() {
        return value;
    }

    /** Read raw header values so duplicate headers/cookies cannot disappear during parsing. */
    public static ViewerCredential read(
            List<String> authorisation, List<String> cookies, String sessionCookie) {
        if (sessionCookie == null || !sessionCookie.matches("[A-Za-z0-9_-]+")) {
            throw new IllegalArgumentException("Invalid session cookie name");
        }
        if (authorisation.size() > 1) {
            throw invalid();
        }
        String session = null;
        for (String header : cookies) {
            for (String part : header.split(";", -1)) {
                String item = part.strip();
                int equals = item.indexOf('=');
                String name = equals < 0 ? item : item.substring(0, equals);
                if (sessionCookie.equals(name)) {
                    if (session != null || equals < 0) {
                        throw invalid();
                    }
                    session = item.substring(equals + 1);
                    if (!validToken(session)) {
                        throw invalid();
                    }
                }
            }
        }
        if (!authorisation.isEmpty()) {
            String header = authorisation.getFirst();
            if (session != null || !header.regionMatches(true, 0, "Bearer ", 0, 7)) {
                throw invalid();
            }
            String token = header.substring(7);
            if (!validToken(token)) {
                throw invalid();
            }
            return new ViewerCredential(Kind.BEARER, token);
        }
        return session == null ? null : new ViewerCredential(Kind.SESSION, session);
    }

    static boolean validToken(String token) {
        return token != null && token.length() <= 4096
                && token.matches("[A-Za-z0-9._~+/-]+=*");
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Missing, ambiguous or invalid viewer credential");
    }

    @Override
    public String toString() {
        return "ViewerCredential[" + kind + ", redacted]";
    }
}
