/** Direct TLS and local operator settings for a controlled protected service. */
export interface ProtectedSessionSettings {
  keyStore: string;
  keyStorePassword: string;
  trustStore: string;
  trustStorePassword: string;
  tenant: string;
  policyUrl: string;
  serviceToken: string;
  origin: string;
  operatorPort: number;
  operatorToken: string;
}

export function protectedSessionConfiguration(
  settings: ProtectedSessionSettings,
) {
  return {
    "server.ssl.enabled": true,
    "server.ssl.key-store": settings.keyStore,
    "server.ssl.key-store-password": settings.keyStorePassword,
    "server.http2.enabled": false,
    "server.forward-headers-strategy": "none",
    "zooglass.access.mode": "applicationPolicy",
    "zooglass.access.tenant": settings.tenant,
    "zooglass.access.policy-url": settings.policyUrl,
    "zooglass.access.service-token": settings.serviceToken,
    "zooglass.access.origin": settings.origin,
    "zooglass.access.operator-port": settings.operatorPort,
    "zooglass.access.operator-token": settings.operatorToken,
  };
}
