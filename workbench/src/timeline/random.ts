import { createHash } from "node:crypto";

/** Versioned length-prefixed SHA-256 draw; fixed proof uses an exact one-half probability. */
export function loseReceipt(
  seed: string,
  scenario: string,
): { lost: boolean; digest: string } {
  if (!/^[a-f0-9]{64}$/.test(seed)) {
    throw new Error("Expected 256-bit seed");
  }
  const hash = createHash("sha256");
  for (const part of [
    "zooglass-timeline-draw-v1",
    seed,
    scenario,
    "receipt-loss",
    "source",
    "publication-1",
    "1",
    "receipt",
    "1",
    "loss",
    "0",
  ]) {
    const bytes = Buffer.from(part);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  const digest = hash.digest("hex");
  return { lost: parseInt(digest.slice(0, 2), 16) < 128, digest };
}
