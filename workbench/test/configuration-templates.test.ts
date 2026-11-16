import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  jar,
  runConfiguration as run,
} from "./support/configuration-command.js";

const examples = resolve("../zooglass/docs/examples/configuration");
const authored = await readFile(join(examples, "sales.authored.json"), "utf8");
const expectedRuntime = await readFile(
  join(examples, "sales-sqlite.json"),
  "utf8",
);
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

async function fixture(
  body: string,
  verify: (input: string, output: string, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "configuration templates "));
  const input = join(directory, "authored.json");
  try {
    await writeFile(input, body);
    await verify(input, join(directory, "runtime.json"), directory);
    assert.equal(await readFile(input, "utf8"), body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const expand = (input: string, output: string) =>
  run(["expand", input, "--output", output, "--json"]);

// A literal golden, deliberately independent of the compiler's serializer.
const golden =
  '{"contractVersion":2,"identityWindow":1000,"maxHistoryEntries":1000,"maxStreams":100,"sources":[{"epoch":"day-1","id":"sales"}],"storage":"sqlite","views":[{"fields":{"items":{"facts":{"maxRetainedFacts":100,"minimumBirthSequence":1,"revision":"latestFactRevision"},"mode":"activeFacts","sourceId":"sales","type":"sale"},"total":{"facts":{"maxRetainedFacts":100,"minimumBirthSequence":1,"revision":"latestFactRevision"},"mode":"sumActiveFacts","property":"amount","sourceId":"sales","type":"sale"}},"id":"sales-summary"}]}\n';

test("sales expansion has exact golden bytes, full configuration equality and independently verified hashes", async () => {
  await fixture(authored, async (input, output, directory) => {
    const result = await expand(input, output);
    assert.equal(result.code, 0, result.stdout);
    const bytes = await readFile(output);
    assert.equal(bytes.toString(), golden);
    assert.deepEqual(JSON.parse(bytes.toString()), JSON.parse(expectedRuntime));
    const report = JSON.parse(result.stdout);
    assert.equal(report.inputFormat, "zooglass-config/v1");
    assert.deepEqual(report.expansion, {
      inputSha256: hash(authored),
      outputSha256: hash(bytes),
      toolJarSha256: hash(await readFile(jar)),
    });
    const second = join(directory, "second.json");
    assert.equal((await expand(input, second)).code, 0);
    assert.deepEqual(await readFile(second), bytes);
    for (const operation of ["check", "explain"]) {
      const inspected = await run([operation, input, "--json"]);
      assert.equal(inspected.code, 0);
      const parsed = JSON.parse(inspected.stdout);
      assert.equal(parsed.origins.length, 2);
      assert.deepEqual(parsed.origins[0].settings, [
        "facts",
        "sourceId",
        "type",
      ]);
      if (operation === "explain") {
        const runtime = JSON.parse(
          (await run([operation, output, "--json"])).stdout,
        );
        assert.deepEqual(parsed.explanation, runtime.explanation);
      }
    }
  });
});

test("tool identity comes from the running packaged JAR even with spaces in its path", async () => {
  await fixture(authored, async (input, output, directory) => {
    const copied = join(directory, "prepared service.jar");
    await copyFile(jar, copied);
    const result = await run(
      ["expand", input, "--output", output, "--json"],
      undefined,
      ["-Dzooglass.jar=/wrong/path.jar"],
      copied,
    );
    assert.equal(result.code, 0, result.stdout);
    assert.equal(
      JSON.parse(result.stdout).expansion.toolJarSha256,
      hash(await readFile(copied)),
    );
  });
});

test("expansion preserves exact long bounds, source/view arrays and inline fields", async () => {
  const document = JSON.parse(authored);
  document.sources.push({ id: "aaa", epoch: "other" });
  document.views.push({
    id: "aaa",
    fields: { inline: { sourceId: "aaa", type: "report", mode: "arrival" } },
  });
  const text = JSON.stringify(document).replace(
    "{",
    '{"delivery":{"maxQueuedBytes":9223372036854775807},',
  );
  await fixture(text, async (input, output) => {
    const result = await expand(input, output);
    assert.equal(result.code, 0, result.stdout);
    const bytes = await readFile(output, "utf8");
    assert.match(bytes, /"maxQueuedBytes":9223372036854775807/);
    const resultDocument = JSON.parse(bytes);
    assert.deepEqual(resultDocument.sources, document.sources);
    assert.equal(resultDocument.views[0].id, "sales-summary");
    assert.equal(resultDocument.views[1].id, "aaa");
    assert.deepEqual(resultDocument.views[1], document.views[1]);
  });
});

test("authoring grammar rejects unknown, unused, recursive, null and overridden templates without output", async () => {
  const valid = JSON.parse(authored);
  const variants: unknown[] = [
    { ...valid, contractVersion: 2 },
    { ...valid, format: "zooglass-config/v2" },
    { ...valid, fieldTemplates: {} },
    { ...valid, fieldTemplates: { sale: null } },
    {
      ...valid,
      fieldTemplates: {
        ...valid.fieldTemplates,
        unused: valid.fieldTemplates.sale,
      },
    },
    ...["mode", "property", "use", "unknown"].map((key) => ({
      ...valid,
      fieldTemplates: {
        sale: { ...valid.fieldTemplates.sale, [key]: "forbidden" },
      },
    })),
    ...[
      { use: "missing", mode: "activeFacts" },
      { use: "sale" },
      { use: "sale", mode: "activeFacts", sourceId: "sales" },
      { use: null, mode: "activeFacts" },
    ].map((field) => ({
      ...valid,
      views: [{ ...valid.views[0], fields: { items: field } }],
    })),
  ];
  for (const variant of variants) {
    await fixture(JSON.stringify(variant), async (input, output, directory) => {
      const result = await expand(input, output);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(
        JSON.parse(result.stdout).diagnostics[0].code,
        "invalid-authoring",
      );
      assert.deepEqual(await readdir(directory), ["authored.json"]);
    });
  }
  for (const invalid of [
    authored.replace('"sale": {', '"sale":null,"sale": {'),
    authored.replaceAll('"sale"', '"\\ud800"'),
    authored + " {}",
  ]) {
    await fixture(invalid, async (input, output, directory) => {
      assert.equal((await expand(input, output)).code, 1);
      assert.deepEqual(await readdir(directory), ["authored.json"]);
    });
  }
});

test("invalid later use identifies escaped expanded field and both origins; entity errors do not inherit them", async () => {
  const document = JSON.parse(authored);
  document.views[0].fields["z/~"] = { use: "sale", mode: "arrival" };
  await fixture(JSON.stringify(document), async (input, output) => {
    const result = await expand(input, output);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.diagnostics[0].path, "/views/0/fields/z~1~0");
    assert.deepEqual(report.origins, [
      {
        path: "/views/0/fields/z~1~0",
        usePath: "/views/0/fields/z~1~0/use",
        templatePath: "/fieldTemplates/sale",
        settings: ["facts", "sourceId", "type"],
      },
    ]);
  });
  delete document.views[0].fields["z/~"];
  document.views[0].entities = { unused: { mode: "envelopeEntity" } };
  await fixture(JSON.stringify(document), async (input, output) => {
    const report = JSON.parse((await expand(input, output)).stdout);
    assert.equal(report.diagnostics[0].path, "/views/0/entities/unused");
    assert.deepEqual(report.origins, []);
  });
});

test("small source with repeated large settings stops at the expanded-byte bound", async () => {
  const document = JSON.parse(authored);
  document.fieldTemplates.sale.type = "x".repeat(100_000);
  document.views[0].fields = Object.fromEntries(
    Array.from({ length: 180 }, (_, index) => [
      `f${index}`,
      { use: "sale", mode: "activeFacts" },
    ]),
  );
  const text = JSON.stringify(document);
  assert.ok(Buffer.byteLength(text) < 120_000);
  await fixture(text, async (input, output, directory) => {
    const result = await expand(input, output);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(
      JSON.parse(result.stdout).diagnostics[0].code,
      "expanded-too-large",
    );
    assert.deepEqual(await readdir(directory), ["authored.json"]);
  });
});

test("existing output, same input/output and failed destination remain untouched", async () => {
  await fixture(authored, async (input, output, directory) => {
    await writeFile(output, "keep me");
    for (const destination of [
      output,
      input,
      join(directory, "missing", "runtime.json"),
    ]) {
      assert.equal((await expand(input, destination)).code, 1);
    }
    assert.equal(await readFile(output, "utf8"), "keep me");
    assert.deepEqual((await readdir(directory)).sort(), [
      "authored.json",
      "runtime.json",
    ]);
  });
  await fixture(expectedRuntime, async (input, output, directory) => {
    const result = await expand(input, output);
    assert.equal(result.code, 1);
    assert.equal(
      JSON.parse(result.stdout).diagnostics[0].code,
      "authoring-required",
    );
    assert.deepEqual(await readdir(directory), ["authored.json"]);
  });
});

test("template expansion retains input and priority ordering", async () => {
  const orders = JSON.parse(
    await readFile(join(examples, "orders-memory.json"), "utf8"),
  );
  const document = structuredClone(orders);
  const { mode, ...settings } = document.views[0].fields.delivery;
  delete document.contractVersion;
  document.format = "zooglass-config/v1";
  document.fieldTemplates = { courier: settings };
  document.views[0].fields.delivery = { use: "courier", mode };
  await fixture(JSON.stringify(document), async (input, output) => {
    const result = await expand(input, output);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), orders);
  });
});
