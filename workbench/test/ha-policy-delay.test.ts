import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { PolicyReplies } from "../src/ha-fixture/policy-delay.js";
class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  status = 0;
  writeHead(status: number) {
    this.status = status;
    return this;
  }
  end() {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
  get response() {
    return this as unknown as ServerResponse;
  }
}
test("policy replies delay delivery but peer and fixture closure discard pending work", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const replies = new PolicyReplies(),
    sent: string[] = [];
  const first = new Response(),
    peerClosed = new Response(),
    fixtureClosed = new Response();
  replies.send(first.response, 20, () => sent.push("first"));
  replies.send(peerClosed.response, 30, () => sent.push("closed"));
  assert.equal(replies.pending, 2);
  peerClosed.emit("close");
  t.mock.timers.tick(19);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(1);
  assert.deepEqual(sent, ["first"]);
  assert.equal(replies.pending, 0);
  replies.send(fixtureClosed.response, 20, () => sent.push("shutdown"));
  replies.close();
  t.mock.timers.tick(100);
  assert.deepEqual(sent, ["first"]);
  assert.equal(replies.pending, 0);
});
test("delayed policy work rejects invalid delays and refuses excess capacity", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const replies = new PolicyReplies(1),
    first = new Response(),
    excess = new Response();
  for (const invalid of [-1, 5001, 1.5, NaN])
    assert.throws(
      () => replies.send(first.response, invalid, () => {}),
      /between/,
    );
  replies.send(first.response, 5000, () => {});
  replies.send(excess.response, 100, () =>
    assert.fail("excess request delivered"),
  );
  assert.equal(excess.status, 503);
  assert.equal(replies.pending, 1);
  replies.close();
  assert.equal(replies.pending, 0);
});
