import assert from "node:assert/strict";
import test from "node:test";
import { createViewerLeases } from "../src/browser/viewer-leases.js";

test("pairing is single-use and expiring; refresh, revocation and controller epochs are scoped", () => {
  let now = 0;
  const leases = createViewerLeases(() => now);
  const first = leases.issue("Phone", true);
  const owner = leases.claim({ pair: first.token });
  assert.throws(() => leases.claim({ pair: first.token }));
  assert.throws(
    () => leases.claim({ lease: owner.id, capability: owner.capability }),
    /active connection/,
  );
  const admitted = leases.authority(owner.id);
  leases.disconnect(owner.id);
  assert.throws(admitted);
  assert.throws(() => leases.claim({ lease: owner.id, capability: "wrong" }));
  assert.equal(
    leases.claim({ lease: owner.id, capability: owner.capability }).id,
    owner.id,
  );
  const guest = leases.issue("Desktop");
  const observer = leases.claim({ pair: guest.token });
  assert.throws(() => leases.authority(observer.id), /controller/);
  leases.transfer(observer.id);
  assert.throws(admitted, /changed/);
  leases.authority(observer.id)();
  leases.revoke(owner.id);
  assert.throws(() =>
    leases.claim({ lease: owner.id, capability: owner.capability }),
  );
  const expired = leases.issue("Expired");
  now = 300_001;
  assert.throws(() => leases.claim({ pair: expired.token }), /expired/);
  leases.clear();
  assert.equal(leases.list().length, 0);
  assert.throws(() =>
    leases.claim({ lease: observer.id, capability: observer.capability }),
  );
});
