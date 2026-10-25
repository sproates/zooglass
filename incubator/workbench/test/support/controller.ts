import { fileURLToPath } from "node:url";
import { loadScenario } from "../../src/scenario.js";

/** Each test group receives its own scenario data; timing variants clone it locally. */
export function basicScenario() {
  return loadScenario(
    fileURLToPath(
      new URL("../../scenarios/vehicle-browser-basic.json", import.meta.url),
    ),
  );
}

/** A named entry/release gate makes ordering explicit at the test site. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
