import type { AccessMode, Credentials, NodeName } from "./types.js";
export interface RestartOverrides {
  configuration?: unknown;
  tenant?: string;
  schema?: string;
}
export function application(
  mode: AccessMode,
  name: NodeName,
  credentials: Credentials,
  password: string,
  overrides: RestartOverrides = {},
): Record<string, unknown> {
  return {
    "server.address": "0.0.0.0",
    "server.port": 8443,
    "server.ssl.enabled": true,
    "server.ssl.key-store": "file:/fixture/server.p12",
    "server.ssl.key-store-password": password,
    "server.forward-headers-strategy": "none",
    "zooglass.config": `file:/run/ha/config.json`,
    "zooglass.deployment.profile": "ha-static-v1",
    "zooglass.access.mode": mode,
    "zooglass.ha.runtime-id": "fixture-runtime",
    "zooglass.ha.database-url": "jdbc:postgresql://127.0.0.1:15432/fixture",
    "zooglass.ha.database-user": "fixture",
    "zooglass.ha.database-password": credentials.database,
    "zooglass.ha.database-ssl-mode": "disable",
    "zooglass.ha.probe-token": credentials.probe,
    "zooglass.ha.lease-ms": 6000,
    "zooglass.ha.renew-ms": 2000,
    "zooglass.ha.retry-ms": 150,
    ...(overrides.schema
      ? { "zooglass.ha.database-schema": overrides.schema }
      : {}),
    ...(mode === "applicationPolicy"
      ? {
          "zooglass.access.tenant": overrides.tenant ?? "fixture-tenant",
          "zooglass.access.origin": "https://fixture-viewer.example",
          "zooglass.access.policy-url": "https://node-a:19443/decision",
          "zooglass.access.service-token": credentials.policy,
          "zooglass.access.timeout-ms": 5000,
          "zooglass.access.operator-port": 8081,
          "zooglass.access.operator-token": credentials.operator,
        }
      : {}),
    "spring.application.name": name,
  };
}
export function proxyConfiguration(
  credentials: Credentials,
  probeToken = credentials.probe,
  verifyHost?: string,
): string {
  return `global
  maxconn 128
  stats socket ipv4@0.0.0.0:9999 level admin

defaults
  mode tcp
  timeout connect 2s
  timeout client 35s
  timeout server 35s
  timeout check 2s
  retries 0

frontend viewer
  bind :8443
  default_backend zoo

backend zoo
  option httpchk
  http-check send meth GET uri /ha/ready ver HTTP/1.1 hdr Host localhost hdr Authorization "Bearer ${probeToken}"
  http-check expect status 200
${(["node-a", "node-b"] as const).map((name) => `  server ${name} ${name}:8443 check check-ssl verify required ca-file /fixture/cert.pem verifyhost ${verifyHost ?? name} check-sni ${verifyHost ?? name} inter 200ms fall 3 rise 2`).join("\n")}
`;
}
