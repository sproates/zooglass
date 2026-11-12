import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startZooGlassSession,
  type ZooGlassSession,
} from "../../service/zooglass-session.js";
import { createBrowserDataRoute } from "../../browser/browser-data-route.js";
import { orderConfiguration } from "./configuration.js";
import { openOrderSources } from "./source-session.js";
import { orderStep, type OrderStep } from "./timeline.js";
import type { OrderEvent } from "./contracts.js";
import {
  durableSnapshot,
  readOrderSnapshots,
  type recoveryWitness,
} from "./recovery.js";

type Route = ReturnType<typeof createBrowserDataRoute>;
interface OrderRunOptions {
  signal: AbortSignal;
  route(route: Route | undefined): void;
  notice(step: OrderStep): void;
  witness: ReturnType<typeof recoveryWitness>;
  onStep?: (step: OrderStep, signal: AbortSignal) => void | Promise<void>;
  /** Observe owned generations in lifecycle acceptance tests. */
  onService?: (service: ZooGlassSession) => void;
}

/** Run owns durable identities/store; each service generation owns its sockets and JVM. */
export async function openOrderRun(options: OrderRunOptions) {
  const directory = await mkdtemp(join(tmpdir(), "zooglass-order-run-"));
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  let current:
    | {
        service: ZooGlassSession;
        sources: Awaited<ReturnType<typeof openOrderSources>>;
        data: Route;
        failed: () => void;
      }
    | undefined;
  let lastOrder: OrderEvent | undefined;
  let tick = 0;
  const epoch = Date.now();
  let closing: Promise<void> | undefined;
  async function retire() {
    const old = current;
    current = undefined;
    options.route(undefined);
    if (!old) return;
    old.service.signal.removeEventListener("abort", old.failed);
    try {
      await old.data.close();
    } finally {
      try {
        await old.sources.close();
      } finally {
        await old.service.close();
      }
    }
  }
  async function start() {
    const service = await startZooGlassSession({
      configuration: orderConfiguration(),
      databasePath: join(directory, "state.sqlite"),
      signal,
    });
    let sources: Awaited<ReturnType<typeof openOrderSources>> | undefined;
    try {
      sources = await openOrderSources(service.baseUrl, service.signal);
      service.signal.throwIfAborted();
      const failed = () => lifetime.abort(service.signal.reason);
      service.signal.addEventListener("abort", failed, { once: true });
      const data = createBrowserDataRoute(service.baseUrl, service.signal);
      current = { service, sources, data, failed };
      options.route(data);
      options.onService?.(service);
    } catch (error) {
      try {
        await sources?.close();
      } finally {
        await service.close();
      }
      throw error;
    }
  }
  function close() {
    return (closing ??= (async () => {
      lifetime.abort(new Error("Order run closed."));
      try {
        await retire();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })());
  }
  try {
    await start();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    signal,
    databasePath: join(directory, "state.sqlite"),
    close,
    get baseUrl() {
      if (!current) throw new Error("Service is restarting.");
      return current.service.baseUrl;
    },
    async advance(through: number) {
      while (tick <= through) {
        signal.throwIfAborted();
        const step = orderStep(tick, epoch, 3000);
        await current!.sources.execute(step);
        for (const action of step.actions)
          if (
            action.kind === "publish" &&
            !action.retry &&
            action.event.sourceId === "orders" &&
            action.event.entityId === "order-1" &&
            (!lastOrder ||
              action.event.publicationSequence > lastOrder.publicationSequence)
          )
            lastOrder = structuredClone(action.event);
        options.notice(step);
        await options.onStep?.(step, signal);
        tick++;
      }
    },
    async restart() {
      signal.throwIfAborted();
      assert.ok(lastOrder, "A retained publication is required for restart.");
      const expected = await readOrderSnapshots(
        current!.service.baseUrl,
        signal,
      );
      const witness = await options.witness.arm(signal, expected);
      try {
        await retire();
        await witness.lost;
        signal.throwIfAborted();
        await start();
        const restored = await readOrderSnapshots(
          current!.service.baseUrl,
          signal,
        );
        assert.deepEqual(
          restored.map(durableSnapshot),
          expected.map(durableSnapshot),
        );
        await witness.baseline();
        await current!.sources.execute({
          tick,
          description:
            "Retried the last committed order publication after recovery",
          actions: [{ kind: "publish", event: lastOrder, retry: true }],
        });
        const next: OrderEvent = {
          ...lastOrder,
          publicationSequence: lastOrder.publicationSequence + 1,
          payload: {
            ...lastOrder.payload,
            status: "completed",
            observedAt: Date.now(),
          },
        };
        await current!.sources.execute({
          tick,
          description: "Order completed with the next source identity",
          actions: [{ kind: "publish", event: next }],
        });
        const after = await readOrderSnapshots(
          current!.service.baseUrl,
          signal,
        );
        for (const snapshot of after.filter(
          (item) => item.entityId === "order-1",
        )) {
          assert.deepEqual(
            (snapshot.publicationSequences as Record<string, number[]>).order,
            [4],
          );
          assert.equal(
            (snapshot.data as Record<string, { status: string }>).order.status,
            "completed",
          );
        }
        lastOrder = next;
        options.notice({
          tick,
          description:
            "Service recovered: matching viewer baseline, duplicate retry and new order completion checked.",
          actions: [],
        });
      } finally {
        witness.dispose();
      }
    },
  };
}
