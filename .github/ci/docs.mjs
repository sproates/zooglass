import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
const plan = JSON.parse(readFileSync("validation-plan.json", "utf8"));
const errors = [];
for (const path of plan.paths) {
  if (!path.endsWith(".md") || !existsSync(path)) continue;
  const content = readFileSync(path, "utf8");
  // Inline local links. External URLs and anchors are reviewed separately.
  for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:|^#|^\//i.test(target)) continue;
    const file = target.split("#")[0];
    if (file && !existsSync(resolve(dirname(path), decodeURIComponent(file)))) {
      errors.push(`${path}: missing ${target}`);
    }
  }
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(
  "Changed Markdown local links checked. Render changed diagrams during review.",
);
