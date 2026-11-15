import { open } from "node:fs/promises";
import { jsonLimits } from "./json.js";

export async function boundedFile(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile())
      throw new Error("invalid-admission: expected regular file");
    const bytes = Buffer.alloc(jsonLimits.bytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      length += bytesRead;
      if (length > jsonLimits.bytes)
        throw new Error("invalid-admission: file byte limit");
      if (bytesRead === 0) return bytes.subarray(0, length);
    }
  } finally {
    await file.close();
  }
}
export const decode = (bytes: Buffer) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
