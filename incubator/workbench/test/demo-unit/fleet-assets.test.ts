import assert from "node:assert/strict";
import test from "node:test";
import {
  fleetAssets,
  interactiveMapConfiguration,
} from "../../src/demos/vehicle/fleet-assets.js";

test("fleet assets default to local tiles; interactive configuration opts into a provider", async () => {
  const local = await fleetAssets();
  assert.equal(
    JSON.parse(local.get("/map-config.json")![1].toString()).tileUrl,
    "/map-tile.svg",
  );
  assert.ok(local.has("/vendor/leaflet/leaflet-src.esm.js"));
  assert.ok(local.has("/vendor/leaflet/LICENSE"));
  assert.equal(
    interactiveMapConfiguration({}).tileUrl,
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  );
  assert.equal(
    interactiveMapConfiguration({ ZOOGLASS_MAP_TILE_URL: "local" }).tileUrl,
    "/map-tile.svg",
  );
  assert.deepEqual(
    interactiveMapConfiguration({
      ZOOGLASS_MAP_TILE_URL: "https://tiles.example/{z}/{x}/{y}.png",
      ZOOGLASS_MAP_ATTRIBUTION: "Example provider",
    }),
    {
      tileUrl: "https://tiles.example/{z}/{x}/{y}.png",
      attribution: "Example provider",
      attributionUrl: undefined,
    },
  );
});

test("custom map providers require an HTTPS template and explicit attribution", () => {
  for (const tileUrl of [
    "http://tiles.example/{z}/{x}/{y}.png",
    "https://tiles.example/plain.png",
    "https://user:password@tiles.example/{z}/{x}/{y}.png",
  ]) {
    assert.throws(() =>
      interactiveMapConfiguration({
        ZOOGLASS_MAP_TILE_URL: tileUrl,
        ZOOGLASS_MAP_ATTRIBUTION: "Example",
      }),
    );
  }
  assert.throws(() =>
    interactiveMapConfiguration({
      ZOOGLASS_MAP_TILE_URL: "https://tiles.example/{z}/{x}/{y}.png",
    }),
  );
});
