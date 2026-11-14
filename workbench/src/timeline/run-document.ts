import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkConfiguredTargets,
  inspectRuntimeConfiguration,
  loadDocument,
  probeLifecycle,
  requiredConfigurationProfile,
} from "./admission.js";
import {
  capabilities,
  lifecycleCapabilities,
  requireExecutionCapabilities,
  sqliteLifecycleCapabilities,
} from "./contract.js";
import { Bridge } from "./bridge.js";
import { RuntimeGenerations } from "./runtime-generations.js";
import { documentEvidenceVersions, fleetProfile } from "./evidence-versions.js";
import { executionSettings } from "./document-profile.js";
import { DocumentExecution } from "./document-execution.js";
import { SemanticTrace, type Counts, type Outcome } from "./semantic-trace.js";
import { integer, list, object } from "./validation.js";
import { captureEnvironment } from "./replay-environment.js";
import { workbenchIdentity } from "./manifest.js";
import { validateTrace } from "./trace-contract.js";
import { RunStore } from "./run-store.js";

export type DocumentOptions = {
  jar: string;
  hostDelay?: number;
  jvmPauseMs?: number;
  paced?: boolean;
  idlePauseMs?: number;
  diagnosticDirectory?: string;
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
  const evidence = documentEvidenceVersions(scenario.document.format);
  let generations: RuntimeGenerations | undefined;
  let store: RunStore | undefined;
  const { bridge, artifact } = await Bridge.open(
    options.jar,
    options.hostDelay,
    options.jvmPauseMs,
  );
  try {
    if (!bridge.documentFormats.includes("timeline-simulation/v1"))
      throw new Error(
        "unsupported-execution: artifact does not implement documents",
      );
    const inspected = await inspectRuntimeConfiguration(
      bridge,
      wire,
      scenario.storage,
    );
    const profile = requiredConfigurationProfile(scenario);
    if (inspected.documentProfile !== profile)
      throw new Error(
        `unsupported-execution: configuration is outside ${profile}`,
      );
    checkConfiguredTargets(scenario, wire);
    requireExecutionCapabilities(
      scenario,
      scenario.storage === "sqlite"
        ? sqliteLifecycleCapabilities
        : evidence.protocol === 2
          ? lifecycleCapabilities
          : capabilities,
    );
    const hostEnvironment =
      evidence.protocol === 2
        ? await probeLifecycle(options.jar, artifact, scenario)
        : undefined;
    const identity = {
      profile: scenario.profile,
      artifactSha256: artifact,
      configurationSha256: configurationHash,
      workbenchSha256: await workbenchIdentity(),
    };
    const environment = await captureEnvironment(bridge);
    if (evidence.protocol === 2) environment.executor = `${scenario.profile}/1`;
    if (scenario.storage === "sqlite") environment.java = hostEnvironment!;
    options.admitReplay?.(identity, environment);
    const until = integer(scenario.document.untilMs, "untilMs");
    const trace = new SemanticTrace(
      {
        format: evidence.trace,
        scenarioSha256: createHash("sha256")
          .update(scenario.canonical)
          .digest("hex"),
        untilMs: until,
        execution: identity,
      },
      settings.traceBytes,
      options.observeRecord,
    );
    let outcome: Outcome = "passed";
    let message: string | undefined;
    let counts: Counts | undefined;
    let run: DocumentExecution | undefined;
    try {
      const epochMillis = integer(
        object(scenario.document.clock, "clock").epochMillis,
        "epochMillis",
      );
      if (evidence.protocol === 2) {
        await bridge.close();
        if (scenario.storage === "sqlite")
          store = await RunStore.create(options.diagnosticDirectory);
        generations = new RuntimeGenerations({
          jar: options.jar,
          configuration: wire,
          ...(scenario.profile === fleetProfile
            ? { profile: fleetProfile }
            : {}),
          epochMillis,
          commandLimit: settings.turns,
          hostDelay: options.hostDelay,
          jvmPauseMs: options.jvmPauseMs,
          expectedArtifact: artifact,
          expectedEnvironment:
            scenario.storage === "sqlite"
              ? hostEnvironment
              : bridge.environment,
          database: store?.database,
          observationTargets: scenario.observationTargets.length
            ? scenario.observationTargets
            : undefined,
        });
      }
      const activeRun = new DocumentExecution(
        generations ?? bridge,
        scenario,
        trace,
        settings,
      );
      run = activeRun;
      activeRun.agenda.add(
        0,
        0,
        () => activeRun.initialize(wire, configurationHash, epochMillis),
        undefined,
        true,
      );
      activeRun.preload();
      const assertions = list(scenario.document.assertions, "assertions").map(
        (a) => object(a, "assertion"),
      );
      const times = [
        ...new Set([...assertions.map((a) => integer(a.atMs, "atMs")), until]),
      ].sort((a, b) => a - b);
      for (const time of times) {
        await activeRun.settle(time);
        for (const assertion of assertions.filter(
          (a) => integer(a.atMs, "atMs") === time,
        ))
          await activeRun.assertObservation(assertion);
        if (options.paced) await delay(1);
        if (options.idlePauseMs) await delay(options.idlePauseMs);
      }
      counts = activeRun.checkEnd(); // Capture before teardown so cancellation cannot rescue failed end conditions.
      await activeRun.shutdown();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      outcome = message.startsWith("assertion-failed:")
        ? "assertion-failed"
        : message.startsWith("limit-exceeded:")
          ? "limit-exceeded"
          : "infrastructure-failed";
      counts = run?.counts();
    }
    if (generations) {
      try {
        await generations.close();
      } catch (error) {
        const cleanup = error instanceof Error ? error.message : String(error);
        message = `${message ? message + "; " : ""}runtime cleanup failed: ${cleanup}`;
        outcome = "infrastructure-failed";
      }
    }
    // Final validation must not discard evidence after the runtime has started.
    const prefix = trace.prefix();
    let result = prefix;
    if (outcome !== "infrastructure-failed") {
      try {
        result = validateTrace(
          store
            ? trace.previewFinish(outcome, counts!)
            : trace.finish(outcome, counts!),
          scenario.observationTargets,
          scenario.storage,
        );
      } catch (error) {
        outcome = "infrastructure-failed";
        message = error instanceof Error ? error.message : String(error);
        result = prefix;
      }
    }
    let retainedStore: { directory: string; database?: string } | undefined;
    if (store) {
      const admittedStore = store;
      const retain = async () => ({
        directory: admittedStore.directory,
        database: await admittedStore.retainedDatabase(),
      });
      try {
        if (outcome === "passed") await store.remove();
        else retainedStore = await retain();
      } catch (error) {
        const cleanup = error instanceof Error ? error.message : String(error);
        message = `${message ? message + "; " : ""}database cleanup failed: ${cleanup}`;
        outcome = "infrastructure-failed";
        result = prefix;
        retainedStore = await retain().catch(() => ({
          directory: admittedStore.directory,
        }));
      }
    }
    if (store && outcome !== "infrastructure-failed") {
      try {
        trace.finish(outcome, counts!);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        outcome = "infrastructure-failed";
        result = prefix;
      }
    }
    return {
      format: evidence.run,
      environment,
      diagnostics: {
        hostDelayMs: options.hostDelay ?? 0,
        paced: options.paced ?? false,
        idlePauseMs: options.idlePauseMs ?? 0,
        jvm: bridge.timing ?? null,
        node: bridge.hostPauses,
        ...(generations ? { generations: generations.diagnostics } : {}),
        ...(retainedStore ? { retainedStore } : {}),
      },
      outcome,
      ...(message ? { message } : {}),
      scenario: scenario.canonical,
      configuration: wire,
      execution: identity,
      trace: result,
    };
  } finally {
    await generations?.close().catch(() => {});
    await bridge.close();
  }
}
