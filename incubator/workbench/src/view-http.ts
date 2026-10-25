import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { TraceEntry } from "./playback.js";

export async function checkView(
  baseUrl: string,
  check: Extract<TraceEntry, { kind: "view-check" }>,
  signal: AbortSignal,
): Promise<void> {
  const url = `${baseUrl}/views/${encodeURIComponent(check.viewId)}/${encodeURIComponent(check.entityId)}`;
  const startedAt = Date.now();
  let lastActual: unknown = "view not found";

  while (Date.now() - startedAt < 5_000) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      });
    } catch (error) {
      signal.throwIfAborted();
      lastActual = error instanceof Error ? error.message : String(error);
      await delay(25, undefined, { signal });
      continue;
    }

    if (check.expected === null) {
      if (response.status === 404) {
        console.log(
          `View absence check passed: ${check.viewId} (${check.entityId})`,
        );
        return;
      }
      if (response.ok) {
        throw new Error(
          `Expected view ${check.viewId} (${check.entityId}) to be absent, but it was present.`,
        );
      }
      lastActual = `HTTP ${response.status}`;
    } else if (response.ok) {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "data" in body) {
        lastActual = body.data;
        if (isDeepStrictEqual(body.data, check.expected)) {
          console.log(`View check passed: ${check.viewId} (${check.entityId})`);
          return;
        }
      }
    } else {
      lastActual = `HTTP ${response.status}`;
    }

    await delay(25, undefined, { signal });
  }

  throw new Error(
    `View check failed for ${check.viewId} (${check.entityId}). Expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(lastActual)}.`,
  );
}

export async function defineView(
  baseUrl: string,
  entry: Extract<TraceEntry, { kind: "view-definition" }>,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${baseUrl}/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: entry.id,
      fields: entry.fields,
      ordering: entry.ordering,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
  });

  if (response.status !== 201) {
    throw new Error(
      `Could not define view ${entry.id}: ZooGlass returned HTTP ${response.status}.`,
    );
  }
}
