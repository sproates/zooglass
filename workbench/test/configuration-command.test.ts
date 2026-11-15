import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const jar = resolve("../zooglass/target/zooglass.jar");
const examples = resolve("../zooglass/docs/examples/configuration");
const notChecked = [
  "deployment",
  "existingDatabaseCompatibility",
  "timelineEligibility",
];
const basic = {
  contractVersion: 2,
  storage: "sqlite",
  maxStreams: 100,
  identityWindow: 1000,
  maxHistoryEntries: 1000,
  sources: [{ id: "s/~", epoch: "day-1" }],
  views: [
    {
      id: "v",
      fields: { "f/~": { sourceId: "s/~", type: "report", mode: "arrival" } },
    },
  ],
};

async function run(args: string[], cwd?: string, properties: string[] = []) {
  try {
    const result = await execute(
      "java",
      [...properties, "-jar", jar, "config", ...args],
      {
        cwd,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.equal(result.stderr, "");
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    const result = error as Error & {
      code: number;
      stdout: string;
      stderr: string;
      killed: boolean;
    };
    assert.equal(
      result.killed,
      false,
      "offline command must finish without starting a service",
    );
    assert.equal(typeof result.code, "number");
    assert.equal(result.stderr, "");
    return { code: result.code, stdout: result.stdout };
  }
}

async function withInput(
  value: unknown,
  verify: (path: string, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "configuration-command-"));
  const path = join(directory, "input.json");
  try {
    await writeFile(
      path,
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    );
    const before = await readFile(path);
    await verify(path, directory);
    assert.deepEqual(
      await readFile(path),
      before,
      "inspection must not rewrite input",
    );
    assert.deepEqual(
      await readdir(directory),
      ["input.json"],
      "inspection must not create files",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("check report has a fixed schema and accepts both guide examples", async () => {
  for (const [file, storage] of [
    ["orders-memory.json", "memory"],
    ["sales-sqlite.json", "sqlite"],
  ]) {
    const result = await run(["check", join(examples, file!), "--json"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      format: "zooglass-config-report/v1",
      operation: "check",
      inputFormat: "runtime/v2",
      valid: true,
      storage,
      notChecked,
      diagnostics: [],
      explanation: null,
    });
  }
});

test("explain exposes effective policies and escaped default pointers with independent expectations", async () => {
  await withInput(basic, async (path) => {
    const result = await run(["explain", path, "--json"]);
    assert.equal(result.code, 0);
    const explanation = JSON.parse(result.stdout).explanation;
    const progress = {
      mode: "untracked",
      startSequence: null,
      maxReceivedRanges: null,
      maxMissingRanges: null,
    };
    const publication = {
      mode: "publishPartial",
      fields: null,
      maxPendingEntities: null,
    };
    const entity = { mode: "envelopeEntity", keys: null };
    const conflict = { mode: "independentFields" };
    const late = { mode: "acceptLate" };
    const freshness = { mode: "unspecified" };
    assert.deepEqual(explanation.effective, {
      ...basic,
      sources: [{ ...basic.sources[0], progress }],
      views: [
        {
          id: "v",
          fields: {
            "f/~": {
              ...basic.views[0]!.fields["f/~"],
              inputs: null,
              conflict,
              late,
              freshness,
            },
          },
          entities: { "s/~": entity },
          publication,
        },
      ],
      delivery: {
        recovery: "freshSnapshot",
        slowClient: "disconnectOnOverflow",
        maxQueuedMessages: 128,
        maxQueuedBytes: 1048576,
      },
    });
    assert.deepEqual(explanation.defaults, [
      { path: "/delivery/recovery", value: "freshSnapshot" },
      { path: "/delivery/slowClient", value: "disconnectOnOverflow" },
      { path: "/delivery/maxQueuedMessages", value: 128 },
      { path: "/delivery/maxQueuedBytes", value: 1048576 },
      { path: "/sources/0/progress", value: progress },
      { path: "/views/0/publication", value: publication },
      { path: "/views/0/entities/s~1~0", value: entity },
      { path: "/views/0/fields/f~1~0/conflict", value: conflict },
      { path: "/views/0/fields/f~1~0/late", value: late },
      { path: "/views/0/fields/f~1~0/freshness", value: freshness },
    ]);
    assert.equal(
      (await run(["explain", path, "--json"])).stdout,
      result.stdout,
    );
  });
});

test("explicit equivalent policies are not labelled defaults and one input normalises honestly", async () => {
  const document = {
    ...basic,
    delivery: {
      recovery: "freshSnapshot",
      slowClient: "disconnectOnOverflow",
      maxQueuedMessages: 128,
      maxQueuedBytes: 1048576,
    },
    sources: [{ ...basic.sources[0], progress: { mode: "untracked" } }],
    views: [
      {
        id: "v",
        entities: { "s/~": { mode: "envelopeEntity" } },
        publication: { mode: "publishPartial" },
        fields: {
          "f/~": {
            inputs: [{ sourceId: "s/~", type: "report" }],
            mode: "arrival",
            conflict: { mode: "independentFields" },
            late: { mode: "acceptLate" },
            freshness: { mode: "unspecified" },
          },
        },
      },
    ],
  };
  await withInput(document, async (path) => {
    const result = await run(["explain", path, "--json"]);
    assert.equal(result.code, 0);
    const explanation = JSON.parse(result.stdout).explanation;
    assert.deepEqual(explanation.defaults, []);
    assert.equal(explanation.effective.views[0].fields["f/~"].sourceId, "s/~");
    assert.equal(explanation.effective.views[0].fields["f/~"].inputs, null);
    assert.equal(
      explanation.effective.views[0].fields["f/~"].conflict.mode,
      "independentFields",
    );
  });
});

test("accepted null settings are reported as defaults without inventing new null rules", async () => {
  await withInput(
    {
      ...basic,
      sources: [{ ...basic.sources[0], progress: null }],
      views: [
        {
          id: "v",
          fields: {
            "f/~": {
              ...basic.views[0]!.fields["f/~"],
              late: null,
              conflict: null,
            },
          },
        },
      ],
    },
    async (path) => {
      const result = await run(["explain", path, "--json"]);
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).explanation.defaults.length, 10);
    },
  );
});

test("explanation retains exact long bounds and configured priority order", async () => {
  const orders = await readFile(join(examples, "orders-memory.json"), "utf8");
  const document = orders.replace(
    '"maxQueuedBytes": 1048576',
    '"maxQueuedBytes": 9223372036854775807',
  );
  await withInput(document, async (path) => {
    const result = await run(["explain", path, "--json"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"maxQueuedBytes":9223372036854775807/);
    const expected =
      JSON.parse(orders).views[0].fields.delivery.conflict.sources;
    assert.deepEqual(
      JSON.parse(result.stdout).explanation.effective.views[0].fields.delivery
        .conflict.sources,
      expected,
    );
  });
});

test("invalid inputs give structured diagnostics without echoing rejected values", async () => {
  const valid = JSON.stringify(basic);
  for (const value of [
    valid.replace('"maxStreams":100', '"maxStreams":"SECRET-VALUE"'),
    valid.replace(
      '"contractVersion":2',
      '"contractVersion":2,"contractVersion":2',
    ),
    valid.replace('"mode":"arrival"', '"mode":"SECRET-VALUE"'),
    valid + " {}",
    "null",
    "",
    "[]",
    '{"format":"zooglass-config/v1","fieldTemplates":{}}',
    valid.replace('"epoch":"day-1"', '"epoch":"\\ud800"'),
    { ...basic, delivery: null },
    valid.replace('"mode":"arrival"', '"mode":"arrival","freshness":null'),
  ]) {
    await withInput(value, async (path) => {
      const result = await run(["check", path, "--json"]);
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout, /SECRET-VALUE|Exception|BOOT/);
      const report = JSON.parse(result.stdout);
      assert.equal(report.valid, false);
      assert.equal(report.explanation, null);
      assert.equal(report.diagnostics.length, 1);
      assert.equal(typeof report.diagnostics[0].path, "string");
      assert.ok(report.diagnostics[0].reason.length > 0);
    });
  }
});

test("tool byte and encoding limits fail before parsing", async () => {
  for (const [input, code] of [
    [Buffer.alloc(16 * 1024 * 1024 + 1, 32), "input-too-large"],
    [Buffer.from([0xc3, 0x28]), "invalid-encoding"],
  ] as const) {
    await withInput(input, async (path) => {
      const result = await run(["check", path, "--json"]);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stdout).diagnostics[0].code, code);
    });
  }
});

test("usage and unreadable input return distinct exits and machine-readable reports", async () => {
  for (const args of [
    ["--json"],
    ["expand", "unused", "--json"],
    ["check", "unused", "--json", "extra"],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "usage");
  }
  const result = await run([
    "check",
    join(examples, "does-not-exist"),
    "--json",
  ]);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "input-io");
});

test("valid, invalid and usage commands remain offline despite deployment settings", async () => {
  const occupied = createServer();
  await new Promise<void>((accept) => occupied.listen(0, "127.0.0.1", accept));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  try {
    await withInput(basic, async (path, directory) => {
      const properties = [
        `-Dserver.port=${address.port}`,
        "-Dserver.address=127.0.0.1",
        `-Dzooglass.database=${join(directory, "must-not-exist.sqlite")}`,
        "-Dzooglass.access=not-a-policy",
      ];
      for (const [args, code] of [
        [["check", path], 0],
        [["explain", path], 0],
        [["check", path + ".missing"], 1],
        [["bad"], 2],
      ] as const) {
        const result = await run([...args], directory, properties);
        assert.equal(result.code, code);
        assert.doesNotMatch(result.stdout, /Spring|Started ZooGlass/);
      }
      const human = await run(["explain", path]);
      assert.match(human.stdout, /Defaults applied/);
      assert.match(
        human.stdout,
        /Not checked: deployment, existing-database compatibility, timeline eligibility/,
      );
    });
  } finally {
    await new Promise<void>((accept, reject) =>
      occupied.close((error) => (error ? reject(error) : accept())),
    );
  }
});
