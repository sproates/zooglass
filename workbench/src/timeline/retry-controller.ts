import type { Agenda } from "./agenda.js";
import type { Json } from "./json.js";
import { metadataJson } from "./semantic-trace.js";
import type { RetryPolicy } from "./retry-policy.js";

type State = {
  policy: RetryPolicy;
  attempt: number;
  generation: number;
  done: boolean;
  timer?: number;
};
type Ports = {
  agenda: Agenda;
  event: (
    kind: string,
    data: Json,
    parent: string,
    actor: string,
    generation: number,
    causes?: string[],
  ) => string;
  retry: (
    policy: RetryPolicy,
    attempt: number,
    parent: string,
  ) => Promise<void>;
};

/** Virtual receipt deadlines; no host timers or runtime outcomes are synthesized. */
export class RetryController {
  private readonly states = new Map<string, State>();
  private readonly timers = new Map<number, { owner: State; event: string }>();
  constructor(
    policies: RetryPolicy[],
    private readonly ports: Ports,
  ) {
    for (const policy of policies)
      this.states.set(policy.action, {
        policy,
        attempt: 0,
        generation: 0,
        done: false,
      });
  }
  private event(
    state: State,
    kind: string,
    data: unknown,
    parent: string,
    causes: string[] = [],
  ) {
    return this.ports.event(
      kind,
      metadataJson(data),
      parent,
      state.policy.actor,
      state.generation,
      causes,
    );
  }
  private timer(
    state: State,
    at: number,
    phase: number,
    kind: string,
    parent: string,
    run: (dispatch: string) => Promise<void>,
  ) {
    const id = this.ports.agenda.allocateModelTask();
    const event = this.event(
      state,
      "scheduled",
      { taskId: String(id), atMs: at, phase, taskKind: kind },
      parent,
    );
    this.timers.set(id, { owner: state, event });
    state.timer = id;
    this.ports.agenda.add(
      at,
      phase,
      async () => {
        this.timers.delete(id);
        state.timer = undefined;
        const dispatch = this.event(
          state,
          "task-dispatched",
          { taskId: String(id) },
          event,
        );
        await run(dispatch);
      },
      id,
    );
  }
  begin(action: string, attempt: number, generation: number, parent: string) {
    const state = this.states.get(action);
    if (!state) return;
    state.attempt = attempt;
    state.generation = generation;
    this.timer(
      state,
      this.ports.agenda.current[0] + state.policy.receiptTimeoutMs,
      1,
      "source-receipt-timeout",
      parent,
      async (dispatch) => {
        if (state.attempt === state.policy.maxAttempts) {
          this.status(state, "exhausted", dispatch);
          throw new Error(
            `assertion-failed: retry attempts exhausted for ${action}`,
          );
        }
        this.status(state, "timed-out", dispatch);
        this.timer(
          state,
          this.ports.agenda.current[0] + state.policy.retryIntervalMs,
          0,
          "source-retry",
          dispatch,
          async (retry) => {
            await this.ports.retry(state.policy, state.attempt + 1, retry);
          },
        );
      },
    );
  }
  private status(state: State, status: string, parent: string) {
    return this.event(
      state,
      "retry-status",
      {
        actionId: state.policy.action,
        publication: state.policy.publication,
        attempt: state.attempt,
        status,
      },
      parent,
    );
  }
  receipt(action: string, attempt: number, generation: number, parent: string) {
    const state = this.states.get(action);
    if (!state) return;
    if (
      state.done ||
      state.attempt !== attempt ||
      state.generation !== generation
    ) {
      this.status(state, "late-receipt", parent);
      return;
    }
    const acknowledged = this.status(state, "acknowledged", parent);
    state.done = true;
    if (state.timer !== undefined) {
      const timer = this.timers.get(state.timer)!;
      this.event(
        state,
        "cancelled",
        { taskId: String(state.timer) },
        acknowledged,
        [timer.event],
      );
      this.ports.agenda.cancel(state.timer);
      this.timers.delete(state.timer);
      state.timer = undefined;
    }
  }
  pending() {
    return this.timers.size;
  }
  unfinished() {
    return [...this.states.values()].some((state) => !state.done);
  }
}
