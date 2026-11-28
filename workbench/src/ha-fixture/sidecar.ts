import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { HaProducer } from "../service/ha/producer.js";
import { Ownership } from "../service/ha/ownership.js";
import { NodeTransport } from "../service/ha/transport.js";
import { decode } from "../service/ha/protocol.js";
import { encodeJson } from "../json/lossless.js";
import { TcpGate } from "./tcp-gate.js";
import type { SidecarSettings, PolicyMode } from "./types.js";

const settings = JSON.parse(
  await readFile("/fixture/sidecar-settings.json", "utf8"),
) as Record<string, SidecarSettings>;
const config = settings[process.env.HA_NODE!];
if (!config) throw new Error("Missing node fixture settings");
const ca = await readFile("/fixture/cert.pem"),
  key = await readFile("/fixture/key.pem");
const gate = new TcpGate("database", 5432);
await gate.listen(15432);
const protectedMode = config.mode === "applicationPolicy";
const origins = [
  protectedMode ? "http://127.0.0.1:8081" : "https://localhost:8443",
];
const sourceTransport = new NodeTransport({
  origins,
  maxBytes: 1024 * 1024,
  ca,
  localOperator: protectedMode,
  bearer: protectedMode ? config.operatorToken : undefined,
});
const producer = new HaProducer({
  origins,
  ownership: new Ownership(),
  maxBytes: 1024 * 1024,
  localOperator: protectedMode,
  transport: sourceTransport,
});

let mode: PolicyMode = "allow",
  decisions = 0,
  lifetimeMillis = 2000,
  publishing = false;
const policy = https.createServer({ key, cert: ca }, (request, response) => {
  request.resume();
  if (request.headers.authorization !== `Bearer ${config.policyToken}`) {
    response.writeHead(401).end();
    return;
  }
  decisions++;
  if (mode === "unavailable") {
    response.writeHead(503).end();
    return;
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(
      JSON.stringify(
        mode === "deny"
          ? { decision: "deny" }
          : { decision: "allow", subject: "fixture-viewer", lifetimeMillis },
      ),
    );
});
await new Promise<void>((resolve) => policy.listen(19443, "0.0.0.0", resolve));
async function body(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("Control request exceeds bound");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected control object");
  return value as Record<string, unknown>;
}
const control = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.headers.authorization !== `Bearer ${config.controlToken}`) {
    request.resume();
    response.writeHead(401).end("{}");
    return;
  }
  void (async () => {
    if (request.method === "GET" && request.url === "/ready") {
      response.end(JSON.stringify({ ready: true, name: config.name }));
      return;
    }
    if (request.method === "GET" && request.url === "/policy") {
      response.end(JSON.stringify({ mode, decisions, lifetimeMillis }));
      return;
    }
    if (request.method === "GET" && request.url === "/owner") {
      const signal = AbortSignal.timeout(4000),
        channel = await sourceTransport.connect(origins[0], "/events", signal);
      try {
        const frame = decode(await channel.next(signal), 1024 * 1024);
        if ("error" in frame || frame.kind !== "hello")
          throw new Error("Expected owner hello");
        response.end(
          JSON.stringify({
            generation: frame.generation.toString(),
            incarnation: frame.incarnation,
          }),
        );
      } finally {
        channel.close();
      }
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      response.writeHead(404).end("{}");
      return;
    }
    const input = await body(request);
    if (request.url === "/database" && typeof input.cut === "boolean") {
      gate.partition(input.cut);
      response.end("{}");
      return;
    }
    if (
      request.url === "/policy" &&
      ["allow", "deny", "unavailable"].includes(String(input.mode))
    ) {
      if (input.lifetimeMillis !== undefined) {
        if (
          !Number.isInteger(input.lifetimeMillis) ||
          Number(input.lifetimeMillis) < 100 ||
          Number(input.lifetimeMillis) > 5000
        )
          throw new Error("Invalid grant lifetime");
        lifetimeMillis = Number(input.lifetimeMillis);
      }
      mode = input.mode as PolicyMode;
      response.end("{}");
      return;
    }
    if (request.url === "/operator-request") {
      if (
        !protectedMode ||
        !["/views", "/progress", "/facts/retire"].includes(
          String(input.path),
        ) ||
        !["GET", "POST"].includes(String(input.method))
      )
        throw new Error("Unsupported operator probe");
      const result = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port: 8081,
              path: String(input.path),
              method: String(input.method),
              signal: AbortSignal.timeout(4000),
              headers: {
                Authorization: `Bearer ${config.operatorToken}`,
                ...(input.upgrade
                  ? {
                      Upgrade: "websocket",
                      Connection: "Upgrade",
                      "Sec-WebSocket-Key": "AAAAAAAAAAAAAAAAAAAAAA==",
                      "Sec-WebSocket-Version": "13",
                      "Sec-WebSocket-Protocol": "zooglass.ha.v1",
                    }
                  : {}),
              },
            },
            (res) => {
              let text = "";
              res.on("data", (chunk) => {
                text += String(chunk);
                if (text.length > 65536)
                  res.destroy(new Error("Oversized operator reply"));
              });
              res.on("error", reject);
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, body: text }),
              );
            },
          );
          req.on("error", reject);
          req.on("upgrade", (_res, socket) => {
            socket.destroy();
            reject(new Error("Unsupported control upgraded"));
          });
          req.end();
        },
      );
      response.end(JSON.stringify(result));
      return;
    }
    if (request.url === "/publish" && typeof input.bytes === "string") {
      if (publishing) throw new Error("Only one publication may be pending");
      if (producer.retained && producer.retained.bytes !== input.bytes)
        throw new Error("An unresolved publication has different bytes");
      publishing = true;
      try {
        const result = await (producer.retained
          ? producer.retry()
          : producer.publish(input.bytes));
        response.end(
          JSON.stringify({
            status: result.status,
            receiptJson: result.receipt
              ? encodeJson(result.receipt)
              : undefined,
            ...(result.status === "unresolved"
              ? { publication: result.publication, reason: result.reason }
              : {}),
          }),
        );
      } finally {
        publishing = false;
      }
      return;
    }
    response.writeHead(404).end("{}");
  })().catch(() => {
    if (!response.headersSent) response.writeHead(400);
    response.end(JSON.stringify({ error: "Fixture control failed" }));
  });
});
control.requestTimeout = 35000;
control.headersTimeout = 5000;
await new Promise<void>((resolve) => control.listen(19090, "0.0.0.0", resolve));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  producer.close();
  control.closeAllConnections();
  policy.closeAllConnections();
  await Promise.all([
    gate.close(),
    new Promise<void>((r) => control.close(() => r())),
    new Promise<void>((r) => policy.close(() => r())),
  ]);
}
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});
