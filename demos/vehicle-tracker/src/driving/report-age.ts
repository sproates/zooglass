/** Observation age, not transport activity, determines this demo's freshness label. */
export function reportAge(observedAt: number, now: number, connected: boolean) {
  const seconds = Math.max(0, Math.floor((now - observedAt) / 1000));
  const stale = !connected || seconds >= 8;
  return {
    stale,
    text: `${stale ? "Last reported" : "Reported"} ${seconds}s ago${connected ? "" : " · viewer disconnected"}`,
  };
}
