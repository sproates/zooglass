import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { docker } from "../ha-fixture/docker.js";
import { waitFor, type CaseContext } from "./context.js";

/** Observe a real failed acquisition without adding a service endpoint or changing its checks. */
export class BindingObservation {
  private constructor(
    private readonly ctx: CaseContext,
    private readonly previous: string,
  ) {}

  static async open(ctx: CaseContext): Promise<BindingObservation> {
    const previous = await ctx.cluster.sql("SHOW log_statement");
    assert.match(previous, /^(none|ddl|mod|all)$/);
    // The pinned PostgreSQL image's default prefix identifies the backend of every statement.
    assert.ok((await ctx.cluster.sql("SHOW log_line_prefix")).includes("[%p]"));
    await ctx.cluster.sql(
      "ALTER SYSTEM SET log_statement='all'; SELECT pg_reload_conf();",
    );
    await waitFor(
      async () =>
        (await ctx.cluster.sql("SHOW log_statement")) === "all"
          ? true
          : undefined,
      "PostgreSQL statement logging enabled",
      ctx.signal,
    );
    return new BindingObservation(ctx, previous);
  }

  async expiredLease(): Promise<void> {
    await waitFor(
      async () =>
        (await this.ctx.cluster.sql(
          "SELECT NOT COALESCE(lease_until > clock_timestamp(), false) FROM zooglass_runtime",
        )) === "t"
          ? true
          : undefined,
      "database confirms previous lease expired",
      this.ctx.signal,
    );
  }

  async mark(): Promise<string> {
    const marker = `ha_binding_${randomBytes(8).toString("hex")}`;
    await this.ctx.cluster.sql(`SELECT '${marker}'`);
    return marker;
  }

  async rejectedAttempt(marker: string): Promise<string> {
    return waitFor(
      async () => {
        const logs = await docker(
          ["logs", "--tail", "1000", this.ctx.cluster.postgresContainer],
          undefined,
          this.ctx.signal,
        );
        const start = logs.lastIndexOf(marker);
        if (start < 0) return undefined;
        const fresh = logs.slice(start + marker.length);
        const check =
          /\[(\d+)\][^\n]*SELECT schema_version,profile,runtime_id,tenant,configuration,incarnation,attempt,generation,\s*\n[^\n]*FOR UPDATE/.exec(
            fresh,
          );
        if (!check) return undefined;
        const afterCheck = fresh.slice(check.index + check[0].length);
        const rolledBack = new RegExp(
          `\\[${check[1]}\\][^\\n]*(?:execute [^:]*:|statement:)\\s+ROLLBACK\\b`,
        ).test(afterCheck);
        return rolledBack ? check[1] : undefined;
      },
      "candidate authority check followed by same-backend rollback",
      this.ctx.signal,
      30000,
    );
  }

  async close(): Promise<void> {
    await this.ctx.cluster.sql(
      `ALTER SYSTEM SET log_statement='${this.previous}'; SELECT pg_reload_conf();`,
    );
  }
}
