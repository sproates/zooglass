import {
  createSubscriptionClient,
  type ClientBinding,
  type Command,
} from "./subscription-client.js";

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Opt-in recovery policy around the socket protocol, independent of vehicle views. */
export function createRecoveringClient(
  dataPath: string,
  report: (event: Record<string, unknown>) => void,
  fail: (reason: string) => void,
  binding: ClientBinding,
) {
  const desired = new Map<string, { viewId: string; entityId: string }>();
  let generation = 0;
  let observationIndex = 0;
  let instance = 0;
  let connected = false;
  let closed = false;
  let commandPending = false;
  let recovering = false;
  let failed: string | undefined;
  let lifetime: AbortController | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let attempt: AbortController | undefined;
  let awaiting = new Set<string>();
  let snapshotsReceived = () => {};
  const key = (viewId: string, entityId: string) =>
    JSON.stringify([viewId, entityId]);

  const observe = (event: string, detail: Record<string, unknown> = {}) =>
    report({
      type: "observation",
      event,
      ...detail,
      connectionGeneration: generation,
      observationIndex: ++observationIndex,
    });

  function cancel() {
    clearTimeout(deadline);
    lifetime?.abort(new Error("Recovery cancelled."));
    attempt?.abort(new Error("Recovery cancelled."));
    lifetime = undefined;
    recovering = false;
    awaiting.clear();
  }

  function terminal(reason: string, notify = true) {
    if (failed || closed) return;
    failed = reason;
    cancel();
    instance++;
    current.close();
    try {
      binding.onConnection("error", reason);
    } catch {
      // A rendering failure must not prevent reporting the original failure.
    }
    if (notify) fail(reason);
  }

  function createAttempt() {
    const identity = ++instance;
    return createSubscriptionClient(
      dataPath,
      (message) => {
        if (identity !== instance) return;
        const { event, ...detail } = message;
        observe(String(event), detail);
      },
      (reason, transport) => {
        if (identity !== instance) return;
        connected = false;
        if (!transport || !lifetime) {
          terminal(reason);
          return;
        }
        if (recovering) {
          observe("retry-failed", { reason });
          attempt?.abort(new Error(reason));
        } else {
          binding.onConnection("reconnecting", "Data connection interrupted");
          observe("interrupted");
          void recover(lifetime);
        }
      },
      {
        ...binding,
        onConnection(state, reason) {
          if (identity !== instance) return;
          if (state === "connecting") {
            generation++;
            observe("connecting");
          }
          connected = state === "connected";
          if (state === "error" && lifetime) return;
          binding.onConnection(
            recovering && state === "connecting" ? "reconnecting" : state,
            reason,
          );
        },
        onSubscription(viewId, entityId, state) {
          if (identity === instance)
            binding.onSubscription(viewId, entityId, state);
        },
        onView(viewId, entityId, data) {
          if (identity !== instance) return;
          binding.onView(viewId, entityId, data);
          awaiting.delete(key(viewId, entityId));
          if (recovering && awaiting.size === 0) snapshotsReceived();
        },
      },
    );
  }

  let current = createAttempt();

  async function recover(owner: AbortController) {
    recovering = true;
    let tries = 0;
    while (!owner.signal.aborted) {
      try {
        await pause(Math.min(250 * 2 ** tries, 2000), owner.signal);
        tries++;
        if (owner.signal.aborted) return;
        current.close();
        current = createAttempt();
        attempt = new AbortController();
        const signal = AbortSignal.any([owner.signal, attempt.signal]);
        awaiting = new Set(desired.keys());
        const snapshots = new Promise<void>((resolve) => {
          snapshotsReceived = resolve;
        });
        observe("retry-attempt", { attempt: tries });
        const openTimeout = setTimeout(
          () => attempt?.abort(new Error("Connection open timed out.")),
          10_000,
        );
        try {
          await abortable(current.execute({ action: "connect" }), signal);
        } finally {
          clearTimeout(openTimeout);
        }
        for (const subscription of desired.values()) {
          await abortable(
            current.execute({ action: "subscribe", ...subscription }),
            signal,
          );
        }
        if (awaiting.size) await abortable(snapshots, signal);
        signal.throwIfAborted();
        clearTimeout(deadline);
        recovering = false;
        lifetime = undefined;
        observe("recovered");
        return;
      } catch {
        if (owner.signal.aborted) return;
        current.close();
        binding.onConnection("reconnecting", "Waiting to retry");
      }
    }
  }

  return {
    expectRecovery(timeoutMs = 30_000) {
      if (
        failed ||
        closed ||
        commandPending ||
        !connected ||
        recovering ||
        lifetime ||
        desired.size === 0
      )
        throw new Error(
          "Recovery requires an idle connected client with subscriptions.",
        );
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
        throw new Error("Recovery deadline must be between 0 and 30000 ms.");
      lifetime = new AbortController();
      deadline = setTimeout(
        () => terminal("Recovery timed out before all snapshots arrived."),
        timeoutMs,
      );
      observe("recovery-armed");
    },
    async execute(command: Command) {
      if (failed) throw new Error(failed);
      if (closed) throw new Error("Client is closed.");
      if (commandPending)
        throw new Error("A client command is already in progress.");
      if (command.action === "disconnect") {
        cancel();
        desired.clear();
        current.close();
      } else if (recovering)
        throw new Error("Automatic recovery is in progress.");
      commandPending = true;
      try {
        await current.execute(command);
      } finally {
        commandPending = false;
      }
      if (command.action === "disconnect") {
        current = createAttempt();
        connected = false;
        binding.onConnection("disconnected");
      }
      if (command.viewId && command.entityId) {
        const pair = key(command.viewId, command.entityId);
        if (command.action === "subscribe")
          desired.set(pair, {
            viewId: command.viewId,
            entityId: command.entityId,
          });
        if (command.action === "unsubscribe") desired.delete(pair);
      }
      return generation;
    },
    fail(reason: string) {
      terminal(reason, false);
    },
    close() {
      closed = true;
      cancel();
      instance++;
      current.close();
      connected = false;
    },
  };
}
