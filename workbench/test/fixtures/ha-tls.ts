import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

/** Ephemeral credentials for loopback TLS tests; no trust or keys survive the test. */
export async function haTls(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "zooglass-ha-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "certificate.pem");
  const store = join(directory, "server.p12");
  const password = "ephemeral-fixture";
  const run = promisify(execFile);
  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { timeout: 20_000 },
  );
  await run(
    "openssl",
    [
      "pkcs12",
      "-export",
      "-inkey",
      keyPath,
      "-in",
      certPath,
      "-name",
      "server",
      "-out",
      store,
      "-passout",
      `pass:${password}`,
    ],
    { timeout: 20_000 },
  );
  return {
    directory,
    store,
    password,
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  };
}
