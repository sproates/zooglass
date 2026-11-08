package io.zooglass.access;

import java.net.URI;
import java.time.Duration;

/** Validated policy connection settings. Secrets are redacted. */
public record PolicySettings(
        String tenant, URI endpoint, String serviceToken, Duration timeout, int maxConcurrent) {

    public PolicySettings {
        if (tenant == null || tenant.isBlank() || !tenant.equals(tenant.strip())) {
            throw new IllegalArgumentException("A tenant ID without outer whitespace is required");
        }
        if (endpoint == null || !"https".equalsIgnoreCase(endpoint.getScheme())
                || endpoint.getHost() == null || endpoint.getRawUserInfo() != null
                || endpoint.getRawQuery() != null || endpoint.getRawFragment() != null
                || endpoint.getPort() == 0 || endpoint.getPort() > 65535) {
            throw new IllegalArgumentException("Policy endpoint must be an absolute HTTPS URL without credentials, query or fragment");
        }
        if (!ViewerCredential.validToken(serviceToken)) {
            throw new IllegalArgumentException("A valid policy service token is required");
        }
        if (timeout == null || timeout.compareTo(Duration.ofMillis(1)) < 0
                || timeout.compareTo(Duration.ofSeconds(5)) > 0) {
            throw new IllegalArgumentException("Policy timeout must be between 1 ms and 5 seconds");
        }
        if (maxConcurrent < 1 || maxConcurrent > 256) {
            throw new IllegalArgumentException("Policy concurrency must be between 1 and 256");
        }
    }

    @Override
    public String toString() {
        return "PolicySettings[tenant=" + tenant + ", serviceToken=redacted]";
    }
}
