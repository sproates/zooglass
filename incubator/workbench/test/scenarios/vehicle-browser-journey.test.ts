import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario.js";

test("journey contains twenty unique contiguous positions with only 41 delayed", async () => {
  const scenario = await loadScenario(
    fileURLToPath(
      new URL("../../scenarios/vehicle-browser-journey.json", import.meta.url),
    ),
  );
  const events = scenario.timeline.filter(
    (entry) => entry.kind === "source-event",
  );

  assert.equal(events.length, 20);
  assert.deepEqual(
    events.map((event) => event.payload.sequence),
    [40, 42, 41, ...Array.from({ length: 17 }, (_, index) => index + 43)],
  );

  const lateIndex = scenario.timeline.findIndex(
    (entry) => entry.kind === "source-event" && entry.payload.sequence === 41,
  );

  assert.equal(
    scenario.timeline[lateIndex + 1].kind,
    "view-check",
    "Late arrival needs a service processing barrier before checking an unchanged marker.",
  );
  assert.equal(
    (scenario.timeline[lateIndex + 1] as { viewId: string }).viewId,
    "trip-history",
  );
  for (const event of events) {
    assert.ok(
      Number(event.payload.latitude) >= 50.95 &&
        Number(event.payload.latitude) <= 51.35,
    );
    assert.ok(
      Number(event.payload.longitude) >= -0.35 &&
        Number(event.payload.longitude) <= 0.05,
    );
  }
});
