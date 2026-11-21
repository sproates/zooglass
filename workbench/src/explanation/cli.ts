import { writeExplanation } from "./reader.js";
import { terminalText } from "./render.js";

function argumentsForReport(args: string[]) {
  const positional: string[] = [];
  let format: "text" | "json" | undefined;
  let selected: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--format" && format === undefined) {
      const value = args[++index];
      if (value !== "text" && value !== "json")
        throw new Error("Expected --format text|json");
      format = value;
    } else if (arg === "--event" && selected === undefined) {
      selected = args[++index];
      if (!selected || selected.startsWith("--"))
        throw new Error("Expected --event EVENT_ID");
    } else if (arg.startsWith("--"))
      throw new Error(`Unknown or repeated option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2 || format === undefined)
    throw new Error(
      "Usage: timeline:explain BUNDLE NEW_REPORT --format text|json [--event EVENT_ID]",
    );
  return { directory: positional[0], output: positional[1], format, selected };
}
try {
  const { directory, output, format, selected } = argumentsForReport(
    process.argv.slice(2),
  );
  process.exitCode = await writeExplanation(
    directory,
    output,
    format,
    selected,
  );
} catch (error) {
  console.error(
    terminalText(error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
}
