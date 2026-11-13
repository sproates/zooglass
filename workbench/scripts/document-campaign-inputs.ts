import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CampaignExpectation } from "../src/timeline/campaign-checks.js";

// Literal SHA-256 vectors independently calculated using Python hashlib/struct.
const draws: Record<string, string[]> = {
  "0": ["5cb0737513a4f08d39691341480833fdc36eda57e1a3429b1b148c66adb53787"],
  "1": ["8b9118755229219e32df2c0d93aaf9a447ca535f71f0b2538577a6096999cac2"],
  "2": [
    "2fd34016cde71843be30a1efc8a9b90bbe7a60c8a649a016dcc8e6ec891ef3ab",
    "fab481320ce5e121ba8841bafe53ed56cd43a3fa5d0cfbd63a86a5c1d64ea340",
    "ecf6b18f13009d4ea5249695ef06a230f2ca51e6ccea6918b46831aa97f358cf",
  ],
};
export async function campaignInputs(directory: string) {
  const source = resolve("scenarios/simulation");
  const configuration = await readFile(
    join(source, "warehouse-runtime.json"),
    "utf8",
  );
  await writeFile(join(directory, "warehouse-runtime.json"), configuration, {
    flag: "wx",
  });
  const groups: { id: string; path: string; expected: CampaignExpectation }[] =
    [];
  for (const name of ["warehouse-retry", "automatic-retry", "delayed-links"]) {
    for (const digit of ["0", "1", "2"]) {
      const document = JSON.parse(
        await readFile(join(source, `${name}.json`), "utf8"),
      );
      document.seed = digit.repeat(64);
      if (name === "automatic-retry" && digit !== "2") {
        // These seeds deliver the first receipt: retain the independently authored
        // full target/field expectation, with the original applied outcome.
        const receipt = document.assertions.find(
          (a: { id: string }) => a.id === "receipts",
        ).expected[0];
        receipt.status = "applied";
        receipt.reason = "memory";
        receipt.changedViews = ["stock-view"];
      }
      const id = `${name}-seed-${digit}`;
      const path = join(directory, `${id}.json`);
      await writeFile(path, JSON.stringify(document, null, 2) + "\n", {
        flag: "wx",
      });
      groups.push({
        id,
        path,
        expected: {
          draws: name === "automatic-retry" ? draws[digit] : [],
          losses:
            name === "automatic-retry"
              ? digit === "2"
                ? [true, true, false]
                : [false]
              : [],
          pauseTimes: {
            "writer-handoff": name === "delayed-links" ? 4 : 0,
            "state-effect": name === "delayed-links" ? 13 : 10,
            "alarm-dispatch": name === "delayed-links" ? 63 : 60,
          },
        },
      });
    }
  }
  return groups;
}
