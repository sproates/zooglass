import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
/** Ephemeral CA/server material, valid for direct clients, stable origin and verified internal probes. */
export async function certificates(
  directory: string,
): Promise<{ ca: Buffer; password: string }> {
  const run = promisify(execFile),
    password = "ephemeral-ha-fixture";
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
      "subjectAltName=DNS:localhost,DNS:node-a,DNS:node-b,IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { timeout: 20000 },
  );
  await run(
    "openssl",
    [
      "pkcs12",
      "-export",
      "-inkey",
      join(directory, "key.pem"),
      "-in",
      join(directory, "cert.pem"),
      "-name",
      "server",
      "-out",
      join(directory, "server.p12"),
      "-passout",
      `pass:${password}`,
    ],
    { timeout: 20000 },
  );
  const keytool = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin/keytool")
    : "keytool";
  await run(
    keytool,
    [
      "-importcert",
      "-noprompt",
      "-alias",
      "fixture-ca",
      "-file",
      join(directory, "cert.pem"),
      "-keystore",
      join(directory, "trust.p12"),
      "-storetype",
      "PKCS12",
      "-storepass",
      password,
    ],
    { timeout: 20000 },
  );
  return { ca: await readFile(join(directory, "cert.pem")), password };
}
