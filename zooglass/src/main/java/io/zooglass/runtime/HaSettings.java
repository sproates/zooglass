package io.zooglass.runtime;

import io.zooglass.access.AdmissionAccess;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.Environment;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Properties;

@Component
@HaDeployment
final class HaSettings {
    final HaStaticProfile profile;
    final Duration lease;
    final long renewMillis;
    final long retryMillis;
    private final String url;
    private final Properties credentials = new Properties();
    private final byte[] probe;

    HaSettings(Environment environment, ResourceLoader resources, AdmissionAccess access) throws IOException {
        var properties = Binder.get(environment).bind("zooglass.ha", Bindable.mapOf(String.class, String.class))
                .orElse(java.util.Map.of());
        if (!java.util.Set.of("runtime-id", "database-url", "database-user", "database-password", "database-schema",
                "database-ssl-mode", "probe-token", "lease-ms", "renew-ms", "retry-ms").stream()
                .map(name -> name.replace("-", "")).collect(java.util.stream.Collectors.toSet())
                .containsAll(properties.keySet().stream().map(name -> name.replace("-", "")).toList())) {
            throw new IllegalArgumentException("Unknown HA deployment setting");
        }
        if (!List.of("applicationPolicy", "openDemo").contains(environment.getRequiredProperty("zooglass.access.mode"))
                || !environment.getProperty("server.ssl.enabled", Boolean.class, false)
                || environment.getProperty("server.http2.enabled", Boolean.class, false)
                || !"none".equalsIgnoreCase(environment.getProperty("server.forward-headers-strategy"))
                || Binder.get(environment).bind("server.tomcat.remoteip", Bindable.mapOf(String.class, String.class)).isBound()
                || environment.containsProperty("management.server.port")
                || !"/actuator".equals(environment.getProperty("management.endpoints.web.base-path", "/actuator"))
                || Binder.get(environment).bind("management.endpoints.web.path-mapping", Bindable.mapOf(String.class, String.class)).isBound()) {
            throw new IllegalArgumentException("HA requires explicit access, direct viewer TLS and HTTP/1.1");
        }
        if (environment.containsProperty("zooglass.database") || environment.containsProperty("zooglass.views.config")) {
            throw new IllegalArgumentException("Standalone storage settings are incompatible with HA");
        }
        try (var input = resources.getResource(environment.getRequiredProperty("zooglass.config")).getInputStream()) {
            var json = RuntimeConfiguration.configurationMapper();
            var configuration = RuntimeConfiguration.decode(json, json.readTree(input));
            profile = new HaStaticProfile(required(environment, "runtime-id"), access.tenant(), configuration);
        }
        String token = required(environment, "probe-token");
        if (!token.matches("[A-Za-z0-9._~+/=-]{32,512}") || token.equals(environment.getProperty("zooglass.access.operator-token"))
                || token.equals(environment.getProperty("zooglass.access.service-token"))) {
            throw new IllegalArgumentException("HA requires a separate readiness credential");
        }
        probe = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
        url = required(environment, "database-url");
        if (!url.startsWith("jdbc:postgresql://") || url.contains("?") || url.contains("#") || url.contains("@")) {
            throw new IllegalArgumentException("Expected a PostgreSQL URL without inline credentials or connection options");
        }
        var sslMode = environment.getProperty("zooglass.ha.database-ssl-mode", "verify-full");
        if (!List.of("disable", "verify-full").contains(sslMode)) {
            throw new IllegalArgumentException("Database TLS mode must be verify-full or disable");
        }
        credentials.setProperty("sslmode", sslMode);
        credentials.setProperty("user", required(environment, "database-user"));
        credentials.setProperty("password", required(environment, "database-password"));
        credentials.setProperty("connectTimeout", "3");
        credentials.setProperty("loginTimeout", "3");
        credentials.setProperty("socketTimeout", "12");
        var schema = environment.getProperty("zooglass.ha.database-schema");
        if (schema != null) {
            if (!schema.matches("[a-z_][a-z0-9_]{0,62}")) throw new IllegalArgumentException("Invalid PostgreSQL schema");
            credentials.setProperty("currentSchema", schema);
        }
        lease = Duration.ofMillis(environment.getProperty("zooglass.ha.lease-ms", Long.class, 15000L));
        PostgresAuthority.leaseMillis(lease);
        renewMillis = environment.getProperty("zooglass.ha.renew-ms", Long.class, 5000L);
        retryMillis = environment.getProperty("zooglass.ha.retry-ms", Long.class, 1000L);
        if (renewMillis < 1 || renewMillis >= lease.toMillis() || retryMillis < 1 || retryMillis > 300000) {
            throw new IllegalArgumentException("Invalid HA scheduling intervals");
        }
    }

    private static String required(Environment environment, String field) {
        var value = environment.getRequiredProperty("zooglass.ha." + field);
        if (value.isBlank()) throw new IllegalArgumentException("Empty HA setting: " + field);
        return value;
    }

    boolean permitsProbe(List<String> headers) {
        return headers.size() == 1 && MessageDigest.isEqual(probe, headers.getFirst().getBytes(StandardCharsets.UTF_8));
    }

    Connection connect() throws SQLException {
        return DriverManager.getConnection(url, credentials);
    }
}
