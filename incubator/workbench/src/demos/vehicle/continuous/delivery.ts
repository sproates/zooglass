/** Repeating, staggered faults. Tick and sequence continue across every cycle. */
export type Delivery =
  "normal" | "delayed" | "duplicate" | "lost" | "offline" | "quiet";
export function deliveryAt(tick: number, carIndex: number): Delivery {
  if (tick < 8) return "normal";
  const phase = (tick + carIndex * 23) % 180;
  if (phase >= 70 && phase < 90) return "offline";
  if (phase >= 110 && phase < 130) return "quiet";
  if (phase === 10) return "delayed";
  if (phase === 30) return "duplicate";
  if (phase === 50) return "lost";
  return "normal";
}
