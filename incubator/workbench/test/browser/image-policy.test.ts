import assert from "node:assert/strict";
import test from "node:test";
import { startBrowserHost } from "../../src/browser/browser-host.js";

const assets = new Map<string, readonly [string, Buffer]>([
  ["/", ["text/html", Buffer.from("<title>Image policy probe</title>")]],
]);

test("external image origins do not relax script or data policies", async () => {
  const host = await startBrowserHost("http://127.0.0.1:1", {
    application: {
      clientId: "probe",
      assets,
      imageOrigins: ["https://tiles.example"],
    },
  });
  try {
    const response = await fetch(host.origin);
    const policy = response.headers.get("content-security-policy")!;
    assert.match(policy, /img-src 'self' https:\/\/tiles\.example;/);
    assert.match(policy, /script-src 'self';/);
    assert.match(policy, /connect-src 'self';/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await host.close();
  }
});

test("image origins reject paths, insecure URLs and policy injection", async () => {
  for (const origin of [
    "http://tiles.example",
    "https://tiles.example/path",
    "https://tiles.example; script-src *",
    "https://user:pass@tiles.example",
  ]) {
    await assert.rejects(
      startBrowserHost("http://127.0.0.1:1", {
        application: { clientId: "probe", assets, imageOrigins: [origin] },
      }),
    );
  }
});
