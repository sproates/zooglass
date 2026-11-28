import assert from "node:assert/strict";
import test from "node:test";
import {
  proxyHealth,
  probeRefusalObserved,
} from "../src/ha-fixture/proxy-health.js";

const stats = (status: string, check: string, code = "") =>
  "# pxname,svname,status,description,check_status,check_code,\n" +
  ["node-a", "node-b"]
    .map(
      (node) =>
        `zoo,${node},${status},"description, with comma",${check},${code},`,
    )
    .join("\n") +
  "\n";

test("negative probe evidence rejects startup DOWN and failures at the wrong layer", () => {
  for (const kind of ["credential", "certificate-hostname"] as const) {
    for (const state of [
      stats("DOWN", "INI"),
      stats("DOWN", "L4CON"),
      stats("UP", "L7OK", "200"),
    ]) {
      assert.equal(probeRefusalObserved(proxyHealth(state), kind), false);
    }
  }
  assert.equal(
    probeRefusalObserved(
      proxyHealth(stats("DOWN", "L7STS", "503")),
      "credential",
    ),
    false,
  );
  assert.equal(
    probeRefusalObserved(
      proxyHealth(stats("DOWN", "L7STS", "401")),
      "credential",
    ),
    true,
  );
  assert.equal(
    probeRefusalObserved(
      proxyHealth(stats("DOWN", "L6RSP")),
      "certificate-hostname",
    ),
    true,
  );
});

test("health evidence requires both uniquely identified backends and complete CSV", () => {
  const valid = stats("DOWN", "L7STS", "401");
  const health = proxyHealth(valid);
  assert.deepEqual(
    health.map((row) => row.node),
    ["node-a", "node-b"],
  );
  assert.equal(probeRefusalObserved([health[0]], "credential"), false);
  assert.equal(
    probeRefusalObserved([health[0], health[0]], "credential"),
    false,
  );
  assert.throws(
    () => proxyHealth(valid.replace("node-b", "node-a")),
    /exactly two/,
  );
  assert.throws(
    () => proxyHealth(valid.replace("L7STS,401,\n", "L7STS\n")),
    /Incomplete/,
  );
});
