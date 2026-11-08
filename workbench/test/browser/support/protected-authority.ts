import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as httpsServer } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";

/** Controlled HTTPS authority and static demo host, using generated test certificates. */
export async function protectedAuthority(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "workbench-protected-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, "test.p12");
  const password = "fixture-password";
  const trustStore = join(directory, "trust.p12");
  const certificate = join(directory, "certificate.pem");
  const javaHome = process.env.JAVA_HOME;
  await promisify(execFile)(
    javaHome ? join(javaHome, "bin/keytool") : "keytool",
    [
      "-genkeypair",
      "-alias",
      "fixture",
      "-keyalg",
      "EC",
      "-groupname",
      "secp256r1",
      "-keystore",
      store,
      "-storetype",
      "PKCS12",
      "-storepass",
      password,
      "-dname",
      "CN=localhost",
      "-ext",
      "SAN=dns:localhost,ip:127.0.0.1",
      "-validity",
      "2",
      "-noprompt",
    ],
    { timeout: 20_000 },
  );

  const keytool = javaHome ? join(javaHome, "bin/keytool") : "keytool";
  await promisify(execFile)(
    keytool,
    [
      "-exportcert",
      "-rfc",
      "-alias",
      "fixture",
      "-keystore",
      store,
      "-storepass",
      password,
      "-file",
      certificate,
    ],
    { timeout: 20_000 },
  );
  await promisify(execFile)(
    keytool,
    [
      "-importcert",
      "-alias",
      "fixture",
      "-keystore",
      trustStore,
      "-storetype",
      "PKCS12",
      "-storepass",
      password,
      "-file",
      certificate,
      "-noprompt",
    ],
    { timeout: 20_000 },
  );

  const allowed = new Set(["viewer", "healthy"]);
  const decisions: {
    credential: string;
    operation: string;
    viewId?: string;
  }[] = [];
  const serviceToken = "fixture-policy-service-token";
  const sockets = new Set<Socket>();
  const host = httpsServer(
    { pfx: await readFile(store), passphrase: password },
    async (req, res) => {
      try {
        if (req.url === "/policy" && req.method === "POST") {
          if (req.headers.authorization !== `Bearer ${serviceToken}`) {
            res.writeHead(401).end();
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const request = JSON.parse(Buffer.concat(chunks).toString());
          const credential = request.credential.value;
          decisions.push({
            credential,
            operation: request.operation,
            viewId: request.resource?.viewId,
          });
          const permit =
            request.tenant === "acceptance" &&
            (request.operation === "authenticate" || allowed.has(credential));
          res.writeHead(200, { "Content-Type": "application/json" }).end(
            JSON.stringify(
              permit
                ? {
                    decision: "allow",
                    subject: credential,
                    lifetimeMillis: 1000,
                  }
                : { decision: "deny" },
            ),
          );
          return;
        }
        const paths: Record<string, string> = {
          "/": "pages/basic/index.html",
          "/vehicle.css": "pages/shared/styles.css",
          "/dist/vehicle-client.js": "dist/vehicle-client.js",
          "/dist/recovering-client.js": "dist/recovering-client.js",
          "/dist/subscription-client.js": "dist/subscription-client.js",
          "/dist/view.js": "dist/view.js",
        };
        const path = paths[req.url ?? ""];
        if (!path) {
          res.writeHead(404).end();
          return;
        }
        const body = await readFile(
          new URL(`../../../../demos/vehicle-tracker/${path}`, import.meta.url),
        );
        res
          .writeHead(200, {
            "Content-Type": path.endsWith(".js")
              ? "text/javascript"
              : "text/html",
            "Cache-Control": "no-store",
          })
          .end(body);
      } catch {
        res.writeHead(500).end();
      }
    },
  );
  host.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  });
  const address = host.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;

  return {
    store,
    password,
    trustStore,
    origin,
    serviceToken,
    allowed,
    decisions,
  };
}
