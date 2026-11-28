import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
export async function fixtureRequest(
  url: string,
  token: string,
  ca?: Buffer,
  body?: unknown,
  signal?: AbortSignal,
  timeout = 5000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.request(
      url,
      {
        method: body === undefined ? "GET" : "POST",
        ca,
        rejectUnauthorized: true,
        signal: AbortSignal.any([
          AbortSignal.timeout(timeout),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.zooglass.ha-v1+json",
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += String(chunk);
          if (Buffer.byteLength(text) > 2 * 1024 * 1024)
            res.destroy(new Error("Fixture reply exceeds bound"));
        });
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("Incomplete fixture reply")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export async function waitUntil<T>(
  check: (signal: AbortSignal) => Promise<T | undefined>,
  signal?: AbortSignal,
  timeout = 20000,
): Promise<T> {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(signal ? [signal] : []),
  ]);
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    deadline.throwIfAborted();
    try {
      const result = await check(deadline);
      if (result !== undefined) return result;
    } catch (error) {
      deadline.throwIfAborted();
      last = error;
    }
    try {
      await delay(100, undefined, { signal: deadline });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new Error("HA fixture condition exceeded its deadline", {
        cause: last,
      });
    }
  }
  throw new Error("HA fixture condition exceeded its deadline", {
    cause: last,
  });
}
