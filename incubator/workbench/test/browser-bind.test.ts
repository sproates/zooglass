import assert from "node:assert/strict";
import test from "node:test";
import {
  requireLocalBindAddress,
  startBrowserHttpServer,
} from "../src/browser/browser-http-server.js";

test("HTTP demo binding accepts only private IPv4 and loopback ranges", () => {
  for (const address of [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.255.254",
  ])
    assert.doesNotThrow(() => requireLocalBindAddress(address), address);
  for (const address of [
    "0.0.0.0",
    "8.8.8.8",
    "172.15.255.254",
    "172.32.0.1",
    "192.167.1.1",
    "192.169.1.1",
    "169.254.1.1",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "localhost",
    "::1",
    "::ffff:127.0.0.1",
    "10.0.0.999",
    "127.1",
  ])
    assert.throws(
      () => requireLocalBindAddress(address),
      /private or loopback/,
      address,
    );
});

test("the shared HTTP host rejects public binding before attempting to listen", async () => {
  await assert.rejects(
    startBrowserHttpServer({ clientId: "probe", assets: new Map() }, "8.8.8.8"),
    /private or loopback/,
  );
});
