import assert from "node:assert/strict";
import test from "node:test";
import { runDemo } from "../../src/cli/demo.js";

test("Order dispatch requires the available continuous mode and rejects ambiguous arguments", async () => {
  for (const args of [
    [],
    ["--interactive"],
    ["--continuous", "--interactive"],
    ["--continuous", "--continuous"],
    ["--continuous", "--bind=127.0.0.1", "extra"],
  ]) {
    await assert.rejects(runDemo(["order-tracker", ...args]), /Usage:/);
  }
  await runDemo(["order-tracker", "--help"]);
  await runDemo(["vehicle-tracker", "--help"]);
});
