import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { openOrderRun } from "../../src/demos/orders/run.js";
import { recoveryWitness } from "../../src/demos/orders/recovery.js";
import { createCheckpointController } from "../../src/control/prepared-checkpoints.js";
import type { ZooGlassSession } from "../../src/service/zooglass-session.js";

for (const [stage, action] of [
  ["armed", "reset"],
  ["baseline", "reset"],
  ["baseline", "close"],
] as const) {
  test(
    `${action} cancels recovery waiting for ${stage} and cleans the store`,
    { timeout: 25000 },
    async () => {
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let original: Awaited<ReturnType<typeof openOrderRun>> | undefined;
      const realWitness = recoveryWitness(new Set());
      const controller = createCheckpointController(
        [
          {
            id: "recovery",
            label: "Recovery",
            async execute(run: Awaited<ReturnType<typeof openOrderRun>>) {
              await run.advance(35);
              await run.restart();
            },
          },
        ],
        async (signal) => {
          const run = await openOrderRun({
            signal,
            route() {},
            notice() {},
            witness: {
              receive() {},
              async arm(signal, expected) {
                if (stage === "armed") {
                  reached();
                  return realWitness.arm(signal, expected);
                }
                return {
                  lost: Promise.resolve(),
                  dispose() {},
                  async baseline() {
                    reached();
                    await new Promise<void>((_, reject) => {
                      signal.addEventListener(
                        "abort",
                        () => reject(signal.reason),
                        { once: true },
                      );
                    });
                  },
                };
              },
            },
          });
          original ??= run;
          return run;
        },
        () => {},
        0,
      );
      try {
        await controller.reset();
        const oldBase = original!.baseUrl;
        await access(original!.databasePath);
        const stepping = assert.rejects(controller.step());
        await waiting;
        await controller[action]();
        await stepping;
        assert.equal(
          controller.state.phase,
          action === "reset" ? "ready" : "closed",
        );
        assert.equal(controller.state.completed, 0);
        await assert.rejects(access(original!.databasePath));
        await assert.rejects(fetch(`${oldBase}/actuator/health`));
      } finally {
        await controller.close();
      }
    },
  );
}

test(
  "unexpected service loss fails only its run; Quit removes both stores",
  { timeout: 20000 },
  async () => {
    let service: ZooGlassSession | undefined;
    const options = {
      signal: new AbortController().signal,
      route() {},
      notice() {},
      witness: recoveryWitness(new Set()),
    };
    const first = await openOrderRun({
      ...options,
      onService: (value) => {
        service = value;
      },
    });
    let second: Awaited<ReturnType<typeof openOrderRun>> | undefined;
    try {
      second = await openOrderRun(options);
      await first.advance(0);
      await service!.close();
      assert.equal(first.signal.aborted, true);
      await assert.rejects(first.advance(1));
      await second.advance(0);
      assert.equal(second.signal.aborted, false);
      const snapshot = await fetch(
        `${second.baseUrl}/views/order-summary/order-1`,
      ).then((r) => r.json());
      assert.equal(snapshot.data.order.status, "accepted");
    } finally {
      await first.close();
      await second?.close();
    }
    await assert.rejects(access(first.databasePath));
    if (second) await assert.rejects(access(second.databasePath));
  },
);

test(
  "failed replacement startup can be closed without retaining its store",
  { timeout: 20000 },
  async () => {
    let generations = 0;
    const run = await openOrderRun({
      signal: new AbortController().signal,
      route() {},
      notice() {},
      witness: {
        receive() {},
        async arm() {
          return { lost: Promise.resolve(), async baseline() {}, dispose() {} };
        },
      },
      onService() {
        if (++generations === 2)
          throw new Error("Replacement initialization failed");
      },
    });
    try {
      await run.advance(35);
      await assert.rejects(run.restart(), /Replacement initialization failed/);
    } finally {
      await run.close();
    }
    assert.equal(generations, 2);
    await assert.rejects(access(run.databasePath));
  },
);
