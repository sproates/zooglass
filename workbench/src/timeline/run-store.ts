import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A run may retain its private directory for diagnosis or remove it after a verified close. */
export class RunStore {
  readonly database: string;

  private constructor(readonly directory: string) {
    this.database = join(directory, "runtime.db");
  }

  static async create(parent = tmpdir()) {
    return new RunStore(
      await mkdtemp(join(resolve(parent), "zooglass-timeline-")),
    );
  }

  async remove() {
    await rm(this.directory, { recursive: true, force: true });
  }

  async retainedDatabase() {
    try {
      return (await stat(this.database)).isFile() ? this.database : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
