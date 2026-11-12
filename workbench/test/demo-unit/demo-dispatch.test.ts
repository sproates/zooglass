import assert from "node:assert/strict";
import test from "node:test";
import { runDemo } from "../../src/cli/demo.js";

test("Order dispatch requires exactly one supported mode and rejects ambiguous arguments", async () => {
  for (const args of [
    [],
    ["--unknown"],
    ["--interactive", "--continuous"],
    ["--continuous", "--interactive"],
    ["--continuous", "--continuous"],
    ["--continuous", "--bind=127.0.0.1", "extra"],
  ]) {
    await assert.rejects(runDemo(["order-tracker", ...args]), /Usage:/);
  }
  await runDemo(["order-tracker", "--help"]);
  await runDemo(["vehicle-tracker", "--help"]);
});
