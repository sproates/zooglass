import { readFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { runInNewContext } from "node:vm";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

/** Controlled resource boundaries around the real automatic-demo control flow. */
export function automaticFixture(
  options: {
    failAt?: "browser" | "scenario" | "execute";
    closeFailure?: boolean;
    browserCloseFailure?: boolean;
    delayed?: boolean;
    pendingScenario?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const events = new EventEmitter();
  const process = Object.assign(new EventEmitter(), { exitCode: 0 });
  const stopped = new AbortController();
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    waitForEvent: () => once(page, "close"),
  });
  const browser = {
    page,
    signal: stopped.signal,
    host: {
      origin: "http://browser",
      clientId: "rider-app",
      executor: {},
      publish() {},
    },
    async close() {
      calls.push("close browser");
      if (options.browserCloseFailure)
        throw new Error("browser cleanup failed");
    },
  };
  const mocks: Record<string, unknown> = {
    "node:url": { fileURLToPath: () => "fixture" },
    "./scenario.js": { loadScenario: async () => ({ views: [], clients: [] }) },
    "./playback.js": {
      playScenario: () => [{ simulationTime: options.delayed ? 100 : 0 }],
    },
    "node:timers/promises": {
      setTimeout: (
        _ms: number,
        _value: unknown,
        { signal }: { signal: AbortSignal },
      ) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          events.emit("delay");
        }),
    },
    "./zooglass-session.js": {
      startZooGlassSession: async ({ signal }: { signal: AbortSignal }) => {
        calls.push("start service");
        signal.addEventListener("abort", () => stopped.abort(signal.reason), {
          once: true,
        });
        return {
          baseUrl: "http://service",
          signal,
          async close() {
            calls.push("close service");
          },
        };
      },
    },
    "./vehicle-browser.js": {
      startVehicleBrowserSession: async () => {
        calls.push("start browser");
        if (options.failAt === "browser")
          throw new Error("browser startup failed");
        return browser;
      },
    },
    "./scenario-session.js": {
      openScenarioSession: async (
        _scenario: unknown,
        _url: string,
        { signal }: { signal: AbortSignal },
      ) => {
        calls.push("open scenario");
        if (options.pendingScenario)
          await new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        if (options.failAt === "scenario")
          throw new Error("scenario startup failed");
        return {
          async close() {
            calls.push("close scenario");
            if (options.closeFailure)
              throw new Error("scenario cleanup failed");
          },
        };
      },
    },
    "./vehicle-observer.js": {
      observeVehicleSession: () => ({
        async execute() {
          calls.push("execute");
          if (options.failAt === "execute")
            throw new Error("rendered check failed");
        },
      }),
    },
    "./demo-controller.js": { DemoCleanupError: class extends Error {} },
  };
  function load(name: string): unknown {
    if (name in mocks) return mocks[name];
    if (!["automatic-demo", "vehicle-run"].includes(name))
      throw new Error(`Unexpected module: ${name}`);
    const source = readFileSync(
      new URL(`../../src/${name}.ts`, import.meta.url),
      "utf8",
    ).replaceAll("import.meta.url", JSON.stringify(import.meta.url));
    const exports = {};
    runInNewContext(
      transpileModule(source, {
        compilerOptions: {
          module: ModuleKind.CommonJS,
          target: ScriptTarget.ES2023,
        },
      }).outputText,
      {
        exports,
        require: (path: string) =>
          path in mocks
            ? mocks[path]
            : load(path.replace(/^\.\//, "").replace(/\.js$/, "")),
        URL,
        AbortSignal,
        AbortController,
        AggregateError,
        Error,
        process,
        console: {
          log(message: string) {
            if (message.includes("received by the browser"))
              events.emit("complete");
          },
          error() {
            events.emit("inspection");
          },
        },
      },
    );
    return exports;
  }
  const { runAutomaticDemo } = load("automatic-demo") as {
    runAutomaticDemo(args: string[]): Promise<void>;
  };
  return {
    calls,
    process,
    events,
    page,
    startRun: () => {
      const { startVehicleRun } = load(
        "vehicle-run",
      ) as typeof import("../../src/vehicle-run.js");
      return startVehicleRun(
        {
          name: "Ownership",
          sources: [],
          views: [],
          clients: [],
          timeline: [],
        },
        {
          signal: stopped.signal,
          headless: true,
        },
      );
    },
    run: (headless = true) =>
      runAutomaticDemo([
        "vehicle-tracker",
        ...(headless ? ["--headless"] : []),
      ]),
  };
}
