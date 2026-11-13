import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadDocument } from "./admission.js";
import { capabilities, requireExecutionCapabilities } from "./contract.js";
import { Bridge } from "./bridge.js";
import { documentProfile, executionSettings } from "./document-profile.js";
import { DocumentExecution } from "./document-execution.js";
import { SemanticTrace, type Outcome } from "./semantic-trace.js";
import { integer, list, object } from "./validation.js";
import { captureEnvironment } from "./replay-environment.js";
import { workbenchIdentity } from "./manifest.js";
import { validateTrace } from "./trace-contract.js";

export type DocumentOptions = {
  jar: string;
  hostDelay?: number;
  paced?: boolean;
  idlePauseMs?: number;
  observeRecord?: (line: string) => void;
  admitReplay?: (identity: unknown, environment: unknown) => void;
};
export async function runDocument(path: string, options: DocumentOptions) {
  const { scenario, wire, configurationHash } = await loadDocument(path);
  return executeDocument({ scenario, wire, configurationHash }, options);
}

/** Execute retained inputs directly; replay never resolves the saved configuration path. */
export async function executeDocument(
  {
    scenario,
    wire,
    configurationHash,
  }: Awaited<ReturnType<typeof loadDocument>>,
  options: DocumentOptions,
) {
  const settings = executionSettings(scenario, wire);
  const { bridge, artifact } = await Bridge.open(
    options.jar,
    options.hostDelay,
  );
  try {
    if (!bridge.documentFormats.includes("timeline-simulation/v1"))
      throw new Error(
        "unsupported-execution: artifact does not implement documents",
      );
    const inspected = await bridge.command(0, {
      op: "inspect-configuration",
      wire,
    });
    if (
      inspected.configuration?.documentProfile !== documentProfile ||
      inspected.effects.length ||
      inspected.pendingTasks ||
      inspected.heldFrames
    )
      throw new Error(
        "unsupported-execution: configuration is outside memory-arrival-v1",
      );
    requireExecutionCapabilities(scenario, capabilities);
    const identity = {
      profile: documentProfile,
      artifactSha256: artifact,
      configurationSha256: configurationHash,
      workbenchSha256: await workbenchIdentity(),
    };
    const environment = await captureEnvironment(bridge);
    options.admitReplay?.(identity, environment);
    const until = integer(scenario.document.untilMs, "untilMs");
    const trace = new SemanticTrace(
      {
        format: "timeline-trace/v1",
        scenarioSha256: createHash("sha256")
          .update(scenario.canonical)
          .digest("hex"),
        untilMs: until,
        execution: identity,
      },
      settings.traceBytes,
      options.observeRecord,
    );
    const run = new DocumentExecution(bridge, scenario, trace, settings);
    let outcome: Outcome = "passed";
    let message: string | undefined;
    let counts;
    try {
      run.agenda.add(
        0,
        0,
        () =>
          run.initialize(
            wire,
            configurationHash,
            integer(
              object(scenario.document.clock, "clock").epochMillis,
              "epochMillis",
            ),
          ),
        undefined,
        true,
      );
      run.preload();
      const assertions = list(scenario.document.assertions, "assertions").map(
        (a) => object(a, "assertion"),
      );
      const times = [
        ...new Set([...assertions.map((a) => integer(a.atMs, "atMs")), until]),
      ].sort((a, b) => a - b);
      for (const time of times) {
        await run.settle(time);
        for (const assertion of assertions.filter(
          (a) => integer(a.atMs, "atMs") === time,
        ))
          run.assertObservation(assertion);
        if (options.paced) await delay(1);
        if (options.idlePauseMs) await delay(options.idlePauseMs);
      }
      counts = run.checkEnd(); // Capture before teardown so cancellation cannot rescue failed end conditions.
      await run.shutdown();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      outcome = message.startsWith("assertion-failed:")
        ? "assertion-failed"
        : message.startsWith("limit-exceeded:")
          ? "limit-exceeded"
          : "infrastructure-failed";
      counts = run.counts();
    }
    // Final validation must not discard evidence after the runtime has started.
    const prefix = trace.prefix();
    let result = prefix;
    if (outcome !== "infrastructure-failed") {
      try {
        result = validateTrace(trace.finish(outcome, counts!));
      } catch (error) {
        outcome = "infrastructure-failed";
        message = error instanceof Error ? error.message : String(error);
        result = prefix;
      }
    }
    return {
      format: "timeline-run/v1" as const,
      environment,
      outcome,
      ...(message ? { message } : {}),
      scenario: scenario.canonical,
      configuration: wire,
      execution: identity,
      trace: result,
    };
  } finally {
    await bridge.close();
  }
}
