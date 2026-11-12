import { pathToFileURL } from "node:url";

/** Dispatch demo commands without importing domain implementations into each other. */
export async function runDemo(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Demos:\n  npm run demo -- order-tracker --continuous [--bind=<private IPv4>]\n  npm run demo -- vehicle-tracker --help",
    );
    return;
  }
  if (args[0] === "order-tracker") {
    const { runOrderDemo } = await import("../demos/orders/main.js");
    return runOrderDemo(args.slice(1));
  }
  const { runVehicleDemo } = await import("../demos/vehicle/demo.js");
  return runVehicleDemo(args);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runDemo(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `Demo could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
