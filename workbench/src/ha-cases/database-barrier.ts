import { docker } from "../ha-fixture/docker.js";
import { type CaseContext, waitFor } from "./context.js";

/** Identify the service backend after the agent confirms its write holds the authority row. */
export async function lockedServiceBackend(
  ctx: CaseContext,
  index: number,
): Promise<number> {
  const raw = await docker([
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    ctx.cluster.nodes[index].container,
  ]);
  const network = Object.values(
    JSON.parse(raw) as Record<string, { IPAddress: string }>,
  )[0];
  if (!network || !/^\d+\.\d+\.\d+\.\d+$/.test(network.IPAddress))
    throw new Error("Expected owned node IPv4");
  const pid = await waitFor(
    async () => {
      const rows = await ctx.cluster.sql(
        `SELECT pid FROM pg_stat_activity WHERE client_addr='${network.IPAddress}'::inet AND state='idle in transaction';`,
      );
      if (!rows) return undefined;
      if (!/^[1-9][0-9]*$/.test(rows))
        throw new Error("Expected exactly one paused service transaction");
      return Number(rows);
    },
    "service write transaction holding row lock",
    ctx.signal,
    2500,
  );
  if (!Number.isSafeInteger(pid)) throw new Error("Invalid backend PID");
  ctx.record("service-lock-holder", {
    node: String(index),
    backend: String(pid),
  });
  return pid;
}
