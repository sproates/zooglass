import assert from "node:assert/strict";
import { workbenchIdentity } from "./manifest.js";
import { setTimeout as delay } from "node:timers/promises";
import { Bridge } from "./bridge.js";
import {
  Execution,
  freshness,
  metadata,
  type TraceEntry,
} from "./execution.js";
import { loseReceipt } from "./random.js";
import { assertProofOutputs } from "./oracle.js";
export type Scenario = "receipt" | "delivery";
export type ProofResult = {
  manifest: {
    protocol: number;
    fixture: string;
    artifact: string;
    workbench: string;
    scenario: Scenario;
    seed: string;
  };
  trace: TraceEntry[];
};
export type Options = {
  jar: string;
  scenario: Scenario;
  seed: string;
  hostDelay?: number;
  paced?: boolean;
  idlePause?: boolean;
  disableAlarms?: boolean;
  replay?: ProofResult;
};
const firstPublication =
  '{"sourceId":"feed","epoch":"v1","sourceEntityId":"bus","publicationSequence":1,"type":"position","payload":{"z":-0.0,"n":9007199254740993,"d":1.0000000000000000001,"nested":{"b":2,"a":1}}}';
const publication = (sequence: number) =>
  sequence === 1
    ? firstPublication
    : JSON.stringify({
        sourceId: "feed",
        epoch: "v1",
        sourceEntityId: "bus",
        publicationSequence: sequence,
        type: "position",
        payload: { value: sequence },
      });
const subscription = JSON.stringify({
  action: "subscribe",
  viewId: "position",
  entityId: "bus",
});
export async function runProof(options: Options): Promise<ProofResult> {
  const decision = loseReceipt(options.seed, options.scenario);
  const workbench = await workbenchIdentity();
  const { bridge, artifact } = await Bridge.open(
    options.jar,
    options.hostDelay,
  );
  const manifest = {
    protocol: 1,
    fixture: "timeline-proof-v1",
    artifact,
    workbench,
    scenario: options.scenario,
    seed: options.seed,
  };
  const run = new Execution(
    bridge,
    options.disableAlarms,
    options.paced,
    options.replay?.trace,
  );
  try {
    if (options.replay) {
      assert.deepEqual(
        manifest,
        options.replay.manifest,
        "replay manifest mismatch",
      );
    }
    run.root(0, {
      op: "initialize",
      policy:
        options.scenario === "receipt"
          ? "disconnectOnOverflow"
          : "coalesceLatestState",
    });
    run.root(0, { op: "connect", session: "source-1" });
    for (const session of ["viewer-slow", "viewer-healthy"]) {
      run.root(0, { op: "connect", session });
      if (session === "viewer-slow" && options.scenario === "delivery") {
        run.root(0, { op: "stall", session });
      }
      run.root(0, { op: "subscribe", session, wire: subscription });
    }
    let source = "source-1";
    run.receiptArrival = async (effect) => {
      const receipt = metadata(effect.wire!);
      if (
        options.scenario === "receipt" &&
        receipt.publicationSequence === 1 &&
        effect.session === "source-1"
      ) {
        run.record({ op: "receipt-loss-decision", ...decision });
        if (decision.lost) {
          run.agenda.add(run.agenda.current[0], 0, () =>
            run.command({ op: "disconnect", session: "source-1" }),
          );
          return;
        }
      }
      run.record({ op: "receipt-arrival", session: effect.session }, [effect]);
      if (receipt.publicationSequence === 1) {
        run.agenda.cancel(-1);
      }
    };
    run.root(10, { op: "ingress", session: source, wire: firstPublication });
    if (options.scenario === "receipt") {
      run.agenda.add(
        30,
        1,
        async () => {
          run.record({ op: "source-timeout", attempt: 1 });
          source = "source-2";
          run.agenda.add(30, 0, async () => {
            await run.command({ op: "connect", session: source });
            run.agenda.add(30, 2, () =>
              run.command({
                op: "ingress",
                session: source,
                wire: firstPublication,
              }),
            );
          });
        },
        -1,
        true,
      );
      run.agenda.add(
        110,
        2,
        () =>
          run.command({ op: "ingress", session: source, wire: publication(2) }),
        undefined,
        true,
      );
      await run.barrier(10);
      if (options.idlePause !== false) {
        await delay(150);
      }
      await run.barrier(10);
      assert.equal(
        run.states.length,
        1,
        "frozen host time must not expire state",
      );
      await run.barrier(109);
      assert.equal(run.states.length, 1, "fresh until deadline minus one");
      assert.equal(
        freshness(run.states[0]).receivedAtMillis,
        1_000_010,
        "original receipt timestamp",
      );
      assert.equal(
        metadata(run.receipts[0]).status,
        "applied",
        "first receipt applied",
      );
      assert.equal(
        metadata(run.receipts[0]).version,
        1,
        "first receipt version",
      );
      const duplicates = run.receipts.filter(
        (wire) => metadata(wire).status === "duplicate",
      );
      assert.equal(
        duplicates.length,
        decision.lost ? 1 : 0,
        "timeout retries identical publication after receipt loss",
      );
      if (decision.lost) {
        assert.equal(
          metadata(duplicates[0]).reason,
          "alreadyApplied",
          "retry receipt reason",
        );
        assert.equal(
          metadata(duplicates[0]).version,
          1,
          "retry original version",
        );
      }
      await run.barrier(110);
      assert.deepEqual(
        run.states.map((wire) => [
          metadata(wire).version,
          freshness(wire).freshness,
        ]),
        [
          [1, "fresh"],
          [2, "stale"],
          [3, "fresh"],
        ],
        "deadline must expire before same-time input",
      );
      for (const session of ["viewer-slow", "viewer-healthy"]) {
        assert.deepEqual(
          run.versions(session),
          [0, 1, 2, 3],
          "both intermediate deadline frames",
        );
      }
      assert.ok(
        run.trace.some(
          (entry) =>
            entry.key[0] === 110 &&
            entry.operation.op === "task" &&
            entry.effects.some(
              (effect) =>
                effect.kind === "state" &&
                freshness(effect.wire!).freshness === "stale",
            ),
        ),
        "deadline expiry must originate from alarm",
      );
      await run.barrier(3_600_000);
      assert.equal(
        freshness(run.states.at(-1)!).freshness,
        "stale",
        "alarm must expire during idle jump",
      );
      assert.equal(
        metadata(run.states.at(-1)!).version,
        4,
        "idle expiry version",
      );
    } else {
      for (const sequence of [2, 3, 4]) {
        run.root(20, {
          op: "ingress",
          session: source,
          wire: publication(sequence),
        });
      }
      run.root(40, { op: "release", session: "viewer-slow", fail: false });
      await run.barrier(20);
      assert.deepEqual(
        run.versions("viewer-healthy"),
        [0, 1, 4],
        "healthy subscriber coalesces same-time burst",
      );
      assert.deepEqual(
        run.versions("viewer-slow"),
        [],
        "held acknowledgement owns one frame",
      );
      assert.equal(run.last!.heldFrames, 1, "one handoff held outside queue");
      await run.barrier(40);
      assert.deepEqual(
        run.versions("viewer-slow"),
        [0, 4],
        "baseline protected; updates coalesced",
      );
      await run.barrier(121);
      assert.deepEqual(
        run.versions("viewer-healthy"),
        [0, 1, 4, 5],
        "healthy expiry delivered",
      );
      assert.deepEqual(
        run.versions("viewer-slow"),
        [0, 4, 5],
        "resumed expiry delivered",
      );
      assert.equal(
        freshness(run.states.at(-1)!).freshness,
        "stale",
        "delivery scenario expiry",
      );
    }
    for (const exact of [
      '"n":9007199254740993',
      '"d":1.0000000000000000001',
      '"z":0',
      '"nested":{"a":1,"b":2}',
    ]) {
      assert.ok(
        run.states[0].includes(exact),
        `lossless canonical vector ${exact}`,
      );
    }
    for (const session of ["viewer-slow", "viewer-healthy"]) {
      assert.equal(
        metadata(run.clients.get(session)![0]).type,
        "subscribed",
        "ack precedes baseline",
      );
    }
    assert.equal(
      run.last!.pendingTasks,
      0,
      "no pending runtime work at horizon",
    );
    assert.equal(run.last!.heldFrames, 0, "no held handoff at horizon");
    assert.deepEqual(
      run.agenda.pending(),
      [],
      "no pending agenda work at horizon",
    );
    assertProofOutputs(run, options.scenario, decision.lost);
    run.agenda.add(run.agenda.current[0], 0, () =>
      run.command({ op: "shutdown" }),
    );
    await run.agenda.through(run.agenda.current[0]);
    if (options.replay) {
      assert.equal(
        run.trace.length,
        options.replay.trace.length,
        `first divergence at turn ${run.trace.length}`,
      );
    }
    return {
      manifest,
      trace: run.trace,
    };
  } catch (error) {
    if (error instanceof Error) {
      Object.assign(error, {
        proof: {
          manifest,
          trace: run.trace,
        },
      });
    }
    throw error;
  } finally {
    await bridge.close();
  }
}
export function compareReplay(expected: ProofResult, actual: ProofResult) {
  assert.deepEqual(
    actual.manifest,
    expected.manifest,
    "replay manifest mismatch",
  );
  for (
    let index = 0;
    index < Math.max(expected.trace.length, actual.trace.length);
    index++
  ) {
    assert.deepEqual(
      actual.trace[index],
      expected.trace[index],
      `first divergence at turn ${index}`,
    );
  }
}
