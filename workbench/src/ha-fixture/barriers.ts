import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export type BarrierStage = "before" | "after" | "write-before" | "write-locked";
const stages = ["before", "after", "write-before", "write-locked"];
/** File protocol owned by the separately prepared, nonshipping Java fault agent. */
export class BarrierFiles {
  constructor(
    private readonly directory: string,
    private readonly signal?: AbortSignal,
  ) {}
  private path(stage: BarrierStage, token: string, suffix: string): string {
    if (!stages.includes(stage) || !/^[0-9a-f]{24}$/.test(token))
      throw new Error("Invalid barrier identity");
    return join(this.directory, `${stage}-${token}.${suffix}`);
  }
  async arm(stage: BarrierStage): Promise<string> {
    if (!stages.includes(stage)) throw new Error("Invalid barrier stage");
    await access(
      join(
        this.directory,
        stage.startsWith("write-") ? "authority.installed" : "agent.installed",
      ),
    );
    const token = randomBytes(12).toString("hex");
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${stage}-${token}.tmp`);
    await writeFile(temporary, token, { flag: "wx" });
    try {
      await link(temporary, join(this.directory, `${stage}.arm`));
    } finally {
      await unlink(temporary);
    }
    return token;
  }
  private async wait(
    stage: BarrierStage,
    token: string,
    suffix: string,
  ): Promise<"resumed" | "interrupted" | "reached"> {
    const deadline = AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(this.signal ? [this.signal] : []),
    ]);
    for (;;) {
      deadline.throwIfAborted();
      try {
        await access(this.path(stage, token, "expired"));
        throw new Error("Fault barrier expired before release");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await access(this.path(stage, token, "interrupted"));
        if (suffix === "resumed") return "interrupted";
        throw new Error("Fault barrier interrupted before reaching capture");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await access(this.path(stage, token, suffix));
        return suffix as "resumed" | "reached";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(20, undefined, { signal: deadline });
    }
  }
  async waitReached(stage: BarrierStage, token: string): Promise<void> {
    await this.wait(stage, token, "reached");
  }
  async release(
    stage: BarrierStage,
    token: string,
  ): Promise<"resumed" | "interrupted"> {
    await writeFile(this.path(stage, token, "release"), "");
    return (await this.wait(stage, token, "resumed")) as
      "resumed" | "interrupted";
  }
}
