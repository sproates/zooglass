# Reproducible receipt loss

The bounded document executor supports optional `faults` rules that lose an actual
source receipt by closing its bidirectional source connection. ZooGlass processes
the publication normally and generates its real receipt first. The rule changes
neither that receipt nor committed views. After explicit disconnect/reconnect
actions, a later `source-retry` sends the same retained publication through a fresh
connection generation and can observe its duplicate result.

```json
{
  "faults": [
    {
      "id": "lose-first",
      "kind": "receipt-loss",
      "action": "send-1",
      "probability": { "numerator": 1, "denominator": 2 }
    }
  ]
}
```

`action` names one declared `source-send` or `source-retry`. At most 100 rules and
one rule per action are admitted. A [managed retry policy](timeline-retries.md)
explicitly extends that action selector to its automatic attempt family, using the
actual generation/attempt in each draw. Probabilities are integer pairs with denominator
1–1,000,000 and numerator 0–denominator. Zero never selects loss; equal values
always select it after an accepted draw. Other fault kinds reject. Omitting `faults`
is equivalent to an empty array; null is invalid.

A decision is made only when that action produces a real receipt. Selected loss
schedules an actual host disconnect at phase zero of the next causal round, before
queued receipts arrive. It closes both directions: queued old-generation receipts
are dropped and later source actions cannot use that connection. Root inputs in
the same timestamp and round retain their declared order before the derived close;
already committed publications are not undone. Multiple selected losses in one
generation share one close. An unrelated receipt queued on that generation may
therefore be lost even when its own rule did not select loss.

For an unmanaged source, the scenario must declare a disconnect to normalize its
lifecycle, then reconnect before further sends or retries. The explicit disconnect
is recorded even when the fault has already removed the host session. A managed
source instead declares a [retry policy](timeline-retries.md); its virtual deadlines,
cleanup, fresh connections and generated sends are recorded in the trace.
The [example](../scenarios/simulation/receipt-loss.json) loses the first
receipt for its fixed seed, reconnects, and checks the duplicate receipt and full
fresh/stale view history independently. Client-frame loss, arbitrary link delays,
and partitions remain future work; bounded [automatic retry actors](timeline-retries.md) are available.

## Stable integer draws

Algorithm `sha256-u32-rejection-v1` hashes the following UTF-8 components. Each is
preceded by its four-byte unsigned big-endian byte length:

1. `zooglass-timeline-receipt-loss-v1`
2. The 64-character lowercase hexadecimal scenario seed (as text, not decoded bytes)
3. Scenario ID, rule ID, logical actor ID, source action ID
4. Connection generation as canonical decimal text
5. `source-receipt`
6. Publication attempt as canonical decimal text
7. `loss`
8. Draw index as canonical decimal text, starting at zero

Attempt counts sends of that retained publication by that actor, starting at one,
and survives reconnects. Unrelated actors and other retained publications do not
consume its attempts or draws. Renaming a keyed identity intentionally changes the
stream. Message sequence numbers, trace ordinals and host timing are not draw keys.

Read the first four digest bytes as an unsigned big-endian integer `sample`.
For denominator `d`, reject samples at or above `floor(2^32 / d) * d`; increment
the draw index and hash again. Otherwise lose the receipt iff `sample % d` is less
than the numerator. All arithmetic is exact within the documented integer bounds;
there is no floating-point probability comparison. Sixteen rejected draws stop the
run with `limit-exceeded`, preventing unbounded resampling.

Each draw emits `fault-decision`, including algorithm, rule/action/message IDs,
attempt, draw index, full digest, sample, probability, rejected and lost flags.
Rejected draws cannot lose a receipt. A lost receipt emits `dropped` with reason
`receipt-loss`, retaining its envelope/message ID and a causal reference to the
accepted decision. Only delivered receipts enter the actor's observed list.
The derived `runtime-command` disconnect names that decision as its parent;
`connection-closed` records the actual host effect. Other old-generation receipt
drops name the close as a cause. Replay recomputes and compares every decision
before further execution.

## Independent vectors

These vectors were calculated independently with Python `hashlib` and big-endian
length encoding, and are literal expectations in the TypeScript tests. Common keys:
scenario `warehouse-retry-and-expiry`, rule `lose-first`, actor
`viewer-logical-source`, action `send-1`, generation 1, attempt 1.

| Seed                                                               | Probability   | Index | Digest                                                             | Result           |
| ------------------------------------------------------------------ | ------------- | ----: | ------------------------------------------------------------------ | ---------------- |
| 64 zeroes                                                          | 1/2           |     0 | `5cb0737513a4f08d39691341480833fdc36eda57e1a3429b1b148c66adb53787` | no loss selected |
| 64 twos                                                            | 1/2           |     0 | `2fd34016cde71843be30a1efc8a9b90bbe7a60c8a649a016dcc8e6ec891ef3ab` | lost             |
| `00000000000000000000000000000000000000000000000000000000000125f6` | 999983/999983 |     0 | `ffffc34eef22cca575ad652474aa24098cc8f4e109b18fa195afa815b5f4b736` | rejected         |
| same seed                                                          | 999983/999983 |     1 | `85d4d619cc14d73aaa3cceff6aad20ce7683a7b696ff8c4839fc9c86d2776e48` | lost             |
