import assert from "node:assert/strict";
import test from "node:test";
import {
  controlExchange,
  ControlTransportError,
} from "../../src/execution/control-request.js";
import {
  retireAndCheckReceipt,
  type FactRetirement,
} from "../../src/execution/fact-retirement.js";
import { sportsConfiguration } from "../../src/demos/sports/configuration.js";
import { startSportsProducer } from "../../src/demos/sports/producer.js";
import { startZooGlassSession } from "../../src/service/zooglass-session.js";

async function read(base: string, view: string) {
  const response = await fetch(`${base}/views/${view}/match-1`);
  assert.equal(response.status, 200);
  return response.json();
}

test(
  "partial retirement rejection stops the producer before any new-cycle publication",
  { timeout: 30000 },
  async () => {
    const service = await startZooGlassSession({
      configuration: sportsConfiguration(),
    });
    const realExchange = controlExchange(service.baseUrl, service.signal);
    let producer: Awaited<ReturnType<typeof startSportsProducer>> | undefined;
    let lastObserved: number | undefined;
    const retired: string[] = [];
    try {
      producer = await startSportsProducer(service.baseUrl, {
        cycles: 2,
        tickMs: 10,
        signal: service.signal,
        async exchange(path, request) {
          if (path !== "/facts/retire") return realExchange(path, request);
          const control = request as FactRetirement;
          const response = await realExchange(
            path,
            control.viewId === "scoreboard"
              ? { ...control, fields: ["missing"] }
              : control,
          );
          retired.push(control.viewId);
          return response;
        },
        async onStep(step) {
          if (
            step.cycle === 1 &&
            step.name === "market-refreshed" &&
            step.entityId === "match-1"
          )
            lastObserved = (await read(service.baseUrl, "match-market")).status
              .inputs["match-feed"].observedThrough;
          assert.equal(
            step.cycle,
            1,
            "no successful new-cycle checkpoint after partial failure",
          );
        },
      });
      await assert.rejects(producer.done, /Fact retirement failed/);
      assert.equal(producer.status.state, "failed");
      assert.match(producer.status.error!, /scoreboard/);
      assert.deepEqual(retired, ["match-market", "scoreboard"]);
      for (const view of ["match-market", "scoreboard", "first-reported"]) {
        const state = await read(service.baseUrl, view);
        assert.equal(state.data.match.cycle, 1);
        assert.equal(
          state.status.inputs["match-feed"].observedThrough,
          lastObserved,
        );
        assert.equal(
          state.status.fields.homeScore.facts.minimumBirthSequence,
          view === "match-market" ? 14 : 1,
        );
      }
    } finally {
      await producer?.close();
      await service.close();
    }
  },
);

test(
  "lost committed retirement acknowledgement retries exact floor before resuming",
  { timeout: 30000 },
  async () => {
    const service = await startZooGlassSession({
      configuration: sportsConfiguration(),
    });
    const realExchange = controlExchange(service.baseUrl, service.signal);
    let producer: Awaited<ReturnType<typeof startSportsProducer>> | undefined;
    const controls: object[] = [];
    const outcomes: unknown[] = [];
    try {
      producer = await startSportsProducer(service.baseUrl, {
        cycles: 2,
        tickMs: 10,
        signal: service.signal,
        async exchange(path, control) {
          const response = await realExchange(path, control);
          if (path === "/facts/retire") {
            controls.push(structuredClone(control));
            outcomes.push(response);
            if (controls.length === 1)
              throw new ControlTransportError(
                "Committed reply lost in transit.",
              );
          }
          return response;
        },
        async onStep(step) {
          if (
            step.cycle === 2 &&
            step.name === "metadata" &&
            step.entityId === "match-1"
          ) {
            assert.equal(
              controls.length,
              10,
              "all three views of all matches retired before next metadata",
            );
            for (const view of [
              "match-market",
              "scoreboard",
              "first-reported",
            ]) {
              const state = await read(service.baseUrl, view);
              assert.equal(
                state.status.fields.homeScore.facts.minimumBirthSequence,
                14,
              );
              assert.equal(
                state.status.fields.awayScore.facts.minimumBirthSequence,
                14,
              );
            }
          }
        },
      });
      await producer.done;
      assert.deepEqual(controls[0], controls[1]);
      assert.equal((outcomes[0] as { status: string }).status, "committed");
      assert.equal((outcomes[1] as { status: string }).status, "unchanged");
      assert.equal(producer.status.state, "complete");
    } finally {
      await producer?.close();
      await service.close();
    }
  },
);

test("retirement checks reject wrong floors, echoed identities, fields and statuses without retry", async () => {
  const control = {
    viewId: "scoreboard",
    entityId: "match-1",
    fields: ["homeScore", "awayScore"],
    minimumBirthSequence: 14,
  };
  const valid = {
    kind: "factRetirement",
    status: "committed",
    control,
    floors: { homeScore: 14, awayScore: 14 },
  };
  const invalid = [
    { ...valid, kind: "watermark" },
    { ...valid, status: "rejected" },
    { ...valid, floors: { homeScore: 14, awayScore: 13 } },
    { ...valid, floors: { homeScore: 14 } },
    { ...valid, control: { ...control, viewId: "match-market" } },
    { ...valid, control: { ...control, entityId: "match-2" } },
    { ...valid, control: { ...control, minimumBirthSequence: 15 } },
    { ...valid, control: { ...control, fields: ["homeScore"] } },
  ];
  for (const reply of invalid) {
    let attempts = 0;
    await assert.rejects(
      retireAndCheckReceipt(async () => {
        attempts++;
        return reply;
      }, control),
      /Fact retirement failed/,
    );
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(
    retireAndCheckReceipt(async () => {
      attempts++;
      throw new ControlTransportError("timeout");
    }, control),
    /timeout/,
  );
  assert.equal(attempts, 2, "retry count is bounded");
});
