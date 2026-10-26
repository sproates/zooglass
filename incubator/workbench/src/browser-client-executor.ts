import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientEntry, ClientExecutor } from "./node-client-executor.js";

interface PendingBrowserCommand {
  id: string;
  done: boolean;
  error?: string;
}

/** Command arguments only go to the app; expectations stay in Workbench. */
export function createBrowserClientExecutor(
  clientId: string,
  lifetime: AbortSignal,
  send: (message: Record<string, unknown>) => void,
  fail: (reason: string) => void,
) {
  let active = false;
  let generation = 0;
  let observationIndex = 0;
  let pending: PendingBrowserCommand | undefined;
  const receipts: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const signal = AbortSignal.any([lifetime, controller.signal]);

  function receive(message: Record<string, unknown>) {
    if (message.type === "fatal") {
      fail(String(message.reason));
      return;
    }

    if (message.type === "completed" || message.type === "failed") {
      if (!pending || message.commandId !== pending.id) return;
      if (message.type === "failed") pending.error = String(message.reason);
      else if (
        !Number.isInteger(message.connectionGeneration) ||
        Number(message.connectionGeneration) < generation
      )
        throw new Error("Invalid command generation.");

      pending.done = true;

      return;
    }

    if (
      message.type !== "observation" ||
      !Number.isInteger(message.connectionGeneration) ||
      !Number.isInteger(message.observationIndex)
    )
      throw new Error("Invalid browser observation.");

    const nextGeneration = Number(message.connectionGeneration);
    const index = Number(message.observationIndex);

    if (nextGeneration < generation || index <= observationIndex) return;
    if (nextGeneration > generation) {
      if (message.event !== "opened" || nextGeneration !== generation + 1)
        throw new Error("Unexpected browser connection generation.");

      generation = nextGeneration;
      receipts.length = 0;
    }

    observationIndex = index;

    if (message.event === "view-update") {
      if (
        typeof message.viewId !== "string" ||
        typeof message.entityId !== "string" ||
        !message.data ||
        typeof message.data !== "object"
      )
        throw new Error("Invalid view receipt.");

      if (receipts.length >= 256) {
        fail("Browser receipt buffer exhausted.");
        return;
      }

      receipts.push(message);
    }
  }

  const executor: ClientExecutor = {
    async execute(entry: ClientEntry, callerSignal: AbortSignal) {
      if (entry.clientId !== clientId)
        throw new Error("Browser client binding mismatch.");

      if (active) throw new Error("Browser action already running.");

      const timeout =
        entry.kind === "client-state" || entry.kind === "client-initial-state"
          ? 10_000
          : 5_000;
      const operation = AbortSignal.any([
        signal,
        callerSignal,
        AbortSignal.timeout(timeout),
      ]);

      operation.throwIfAborted();
      active = true;

      try {
        if (entry.kind === "client-view-check") {
          while (true) {
            operation.throwIfAborted();

            const index = receipts.findIndex(
              (message) =>
                message.connectionGeneration === generation &&
                message.viewId === entry.viewId &&
                message.entityId === entry.entityId &&
                isDeepStrictEqual(message.data, entry.expected),
            );

            if (index >= 0) {
              receipts.splice(index, 1);
              return;
            }

            await delay(10, undefined, { signal: operation });
          }
        }

        pending = { id: randomUUID(), done: false };

        const action =
          entry.kind === "client-subscription"
            ? entry.action
            : entry.state === "connected" || entry.state === "connecting"
              ? "connect"
              : "disconnect";

        send({
          type: "command",
          commandId: pending.id,
          action,
          ...(entry.kind === "client-subscription"
            ? { viewId: entry.viewId, entityId: entry.entityId }
            : {}),
        });
        while (!pending.done) {
          await delay(10, undefined, { signal: operation });
        }
        operation.throwIfAborted();

        if (pending.error) throw new Error(pending.error);
      } catch (error) {
        fail(
          `Browser action failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      } finally {
        pending = undefined;
        active = false;
      }
    },
    async close() {
      controller.abort(new Error("Browser executor closed."));
      receipts.length = 0;
    },
  };

  return { executor, receive };
}
