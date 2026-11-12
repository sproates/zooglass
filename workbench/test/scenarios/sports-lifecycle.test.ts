import assert from "node:assert/strict";
import test from "node:test";
import { startSportsSimulation } from "../../src/demos/sports/simulation.js";
import { startSportsProducer } from "../../src/demos/sports/producer.js";

test("Sports validates run limits before opening sources", async () => {
  for (const options of [
    { tickMs: 0 },
    { tickMs: NaN },
    { cycles: 0 },
    { cycles: Infinity },
    { cycles: 1.5 },
  ]) {
    await assert.rejects(
      startSportsProducer("http://127.0.0.1:1", options),
      /Sports (tick interval|cycle count)/,
    );
  }
});
test(
  "continuous Sports cancellation stops publications and closes its owned service",
  { timeout: 30000 },
  async () => {
    const lifetime = new AbortController();
    let checkpoints = 0;
    const simulation = await startSportsSimulation({
      tickMs: 10,
      signal: lifetime.signal,
      onStep() {
        checkpoints++;
        lifetime.abort(new Error("stop fixture"));
      },
    });
    try {
      await assert.rejects(simulation.done);
      assert.equal(simulation.status.state, "stopped");
      assert.equal(checkpoints, 1);
    } finally {
      await simulation.close();
      await simulation.close();
    }
    await assert.rejects(
      fetch(`${simulation.baseUrl}/actuator/health`, {
        signal: AbortSignal.timeout(1000),
      }),
    );
  },
);
test(
  "checkpoint failure is visible and closes the run",
  { timeout: 30000 },
  async () => {
    const simulation = await startSportsSimulation({
      tickMs: 10,
      onStep() {
        throw new Error("observer failed");
      },
    });
    try {
      await assert.rejects(simulation.done, /observer failed/);
      assert.equal(simulation.status.state, "failed");
      assert.equal(simulation.status.error, "observer failed");
    } finally {
      await simulation.close();
    }
  },
);
