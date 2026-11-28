import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import {
  OwnedDocker,
  pinned,
  type CommandRunner,
} from "../src/ha-fixture/docker.js";
import { TcpGate } from "../src/ha-fixture/tcp-gate.js";
import {
  proxyConfiguration,
  application,
} from "../src/ha-fixture/configuration.js";
import { waitUntil } from "../src/ha-fixture/cluster.js";
const credentials = {
  control: "control",
  probe: "probe",
  operator: "operator",
  policy: "policy",
  database: "database",
};

test("ambiguous creation remains owned and cleanup never removes another resource", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "create") throw new Error("connection lost after create");
    return "";
  };
  const owned = new OwnedDocker(run);
  await assert.rejects(owned.create("container", "ours", ["image"]));
  await owned.close();
  assert.deepEqual(calls, [
    ["create", "--name", "ours", "image"],
    ["rm", "-f", "--volumes", "ours"],
  ]);
});
test("cleanup tolerates only proven absence and reports unverifiable leftovers", async () => {
  for (const present of [false, true]) {
    const run: CommandRunner = async (args) => {
      if (args[0] === "rm") throw new Error("remove failed");
      if (args[0] === "ps") return present ? "ours\nunrelated" : "unrelated";
      return "";
    };
    const owned = new OwnedDocker(run);
    await owned.create("container", "ours", []);
    if (present) await assert.rejects(owned.close(), /cleanup failed/);
    else await owned.close();
  }
  const run: CommandRunner = async (args) => {
    if (args[0] !== "create") throw new Error("daemon unreachable");
    return "";
  };
  const owned = new OwnedDocker(run);
  await owned.create("container", "ours", []);
  await assert.rejects(owned.close(), /cleanup failed/);
});
test("cleanup reverses dependencies and continues after an individual removal failure", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "rm" && args.at(-1) === "sidecar")
      throw new Error("not found");
    if (args[0] === "ps") return "node";
    return "";
  };
  const owned = new OwnedDocker(run);
  await owned.create("network", "network", []);
  await owned.create("container", "node", []);
  await owned.create("container", "sidecar", []);
  await owned.close();
  assert.deepEqual(
    calls.filter((c) => c.includes("rm")).map((c) => c.at(-1)),
    ["sidecar", "node", "network"],
  );
});
test("TCP gate severs existing connections, refuses new streams, then restores real forwarding", async (t) => {
  const peers = new Set<net.Socket>();
  const target = net.createServer((socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const gate = new TcpGate(
      "127.0.0.1",
      (target.address() as net.AddressInfo).port,
    ),
    port = await gate.listen();
  t.after(async () => {
    await gate.close();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  const echoed = once(socket, "data");
  socket.write("actual bytes");
  assert.equal(String((await echoed)[0]), "actual bytes");
  const closed = once(socket, "close");
  gate.partition(true);
  await closed;
  const refused = net.connect(port, "127.0.0.1");
  refused.on("error", () => {});
  await once(refused, "close");
  gate.partition(false);
  const recovered = net.connect(port, "127.0.0.1");
  recovered.on("error", () => {});
  await once(recovered, "connect");
  const response = once(recovered, "data");
  recovered.write("restored");
  assert.equal(String((await response)[0]), "restored");
  recovered.destroy();
});
test("fixture configuration preserves passthrough TLS and private local producer ingress", () => {
  const proxy = proxyConfiguration(credentials);
  assert.match(proxy, /mode tcp/);
  assert.match(proxy, /check-ssl verify required/);
  assert.match(proxy, /verifyhost node-a/);
  assert.doesNotMatch(proxy, /8081|ssl crt|forwardfor/);
  assert.match(proxy, /retries 0/);
  const wrongName = proxyConfiguration(credentials, undefined, "wrong.invalid");
  assert.equal(
    (
      wrongName.match(/verifyhost wrong\.invalid check-sni wrong\.invalid/g) ??
      []
    ).length,
    2,
  );
  const app = application(
    "applicationPolicy",
    "node-a",
    credentials,
    "password",
  );
  assert.equal(app["zooglass.access.operator-port"], 8081);
  assert.equal(app["server.forward-headers-strategy"], "none");
  assert.equal(
    app["zooglass.ha.database-url"],
    "jdbc:postgresql://127.0.0.1:15432/fixture",
  );
});
test("fixture rejects floating images and propagates cancellation into bounded waits", async () => {
  assert.throws(() => pinned("postgres:latest"));
  assert.doesNotThrow(() => pinned(`postgres:18@sha256:${"a".repeat(64)}`));
  const stop = new AbortController();
  const pending = waitUntil(async (signal) => {
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    return undefined;
  }, stop.signal);
  stop.abort(new Error("cancelled fixture"));
  await assert.rejects(pending, /cancelled fixture/);
});

test("fault barriers publish complete exclusive tokens and distinguish interruption from expiry", async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { BarrierFiles } = await import("../src/ha-fixture/barriers.js");
  const directory = await mkdtemp(join(tmpdir(), "ha-barrier-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "agent.installed"), "installed");
  const files = new BarrierFiles(directory);
  const token = await files.arm("before");
  assert.equal(await readFile(join(directory, "before.arm"), "utf8"), token);
  await assert.rejects(files.arm("before"), { code: "EEXIST" });
  await writeFile(join(directory, `before-${token}.reached`), "");
  await files.waitReached("before", token);
  await writeFile(join(directory, `before-${token}.interrupted`), "");
  assert.equal(await files.release("before", token), "interrupted");
  await assert.rejects(files.arm("write-locked"), { code: "ENOENT" });
  await writeFile(join(directory, "authority.installed"), "installed");
  const other = await files.arm("write-locked");
  await writeFile(join(directory, `write-locked-${other}.expired`), "");
  await assert.rejects(files.waitReached("write-locked", other), /expired/);
});
