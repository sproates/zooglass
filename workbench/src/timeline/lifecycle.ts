import {
  isRuntimeAction,
  type ActorActionKind,
  type RuntimeActionKind,
} from "./event-schema.js";
import type { Json } from "./json.js";
import type { RetryPolicy } from "./retry-policy.js";
import { integer, invalid, list, object, text } from "./validation.js";

export type AdmittedAction = {
  id: string;
  atMs: number;
  phase: 0 | 2;
  declaration: number;
} & (
  | {
      kind: ActorActionKind;
      actor: string;
      runtimeGeneration?: 1;
      connectionGeneration?: number;
    }
  | {
      kind: RuntimeActionKind;
      actor?: never;
      runtimeGeneration?: never;
      connectionGeneration?: never;
    }
);
type ActorState = {
  connection: "disconnected" | "connected" | "closing";
  generation: number;
  stalled: boolean;
  subscriptions: Set<string>;
  sent: Set<string>;
};

function disconnect(state: ActorState) {
  state.connection = "disconnected";
  state.stalled = false;
  state.subscriptions.clear();
}

/** Admit declared controls, not runtime-derived closes or successful publications. */
export function admitLifecycle(
  doc: { [key: string]: Json },
  lifecycle: boolean,
  policies: readonly RetryPolicy[],
): AdmittedAction[] {
  const states = new Map<string, ActorState>();
  for (const actor of list(doc.actors, "$.actors")) {
    states.set(text(object(actor, "actor").id, "actor.id"), {
      connection: "disconnected",
      generation: 0,
      stalled: false,
      subscriptions: new Set(),
      sent: new Set(),
    });
  }
  const actions = list(doc.actions, "$.actions")
    .map((value, declaration) => {
      const path = `$.actions[${declaration}]`;
      const action = object(value, path);
      const kind = text(action.kind, `${path}.kind`) as
        ActorActionKind | RuntimeActionKind;
      const phase: 0 | 2 =
        ["connect", "disconnect", "writer-stall", "writer-release"].includes(
          kind,
        ) || isRuntimeAction(kind)
          ? 0
          : 2;
      return {
        action,
        path,
        kind,
        phase,
        declaration,
        atMs: integer(action.atMs, `${path}.atMs`),
      };
    })
    .sort(
      (a, b) =>
        a.atMs - b.atMs || a.phase - b.phase || a.declaration - b.declaration,
    );
  const managedSends = new Set(policies.map((policy) => policy.action));
  let running = true;
  let generations = 1;
  return actions.map(({ action, path, kind, phase, declaration, atMs }) => {
    const admitted = {
      id: text(action.id, `${path}.id`),
      atMs,
      phase,
      declaration,
    };
    if (isRuntimeAction(kind)) {
      if (kind === "service-stop") {
        if (!running) invalid(path, "service-stop requires a running service");
        running = false;
        for (const state of states.values()) disconnect(state);
      } else if (kind === "service-start") {
        if (running) invalid(path, "service-start requires a stopped service");
        if (++generations > 16) invalid(path, "at most 16 runtime generations");
        running = true;
      }
      return { ...admitted, kind };
    }

    const actor = text(action.actor, `${path}.actor`);
    const state = states.get(actor)!;
    const fail = (reason: string): never => invalid(path, reason);
    if (kind === "connect") {
      if (state.connection !== "disconnected")
        fail("connect requires a disconnected actor");
      if (running) {
        state.connection = "connected";
        if (!lifecycle) state.generation++;
      }
    } else if (kind === "disconnect") {
      if (state.connection === "disconnected")
        fail("disconnect requires a connected or closing actor");
      disconnect(state);
    } else {
      const sourceAction = kind === "source-send" || kind === "source-retry";
      const unavailable = !running && sourceAction;
      const managedSend = lifecycle && managedSends.has(admitted.id);
      if (state.connection !== "connected" && !unavailable && !managedSend)
        fail(`${kind} requires a connected actor`);
      if (sourceAction) {
        const publication = text(action.publication, `${path}.publication`);
        if (kind === "source-retry") {
          if (!state.sent.has(publication))
            fail(
              "retry requires a prior send by this actor of the same publication",
            );
        } else {
          if (state.sent.has(publication))
            fail("publication was already sent; use source-retry");
          state.sent.add(publication);
        }
      } else if (kind.startsWith("client-")) {
        const target = JSON.stringify([action.viewId, action.entityId]);
        if (kind === "client-subscribe") {
          if (state.subscriptions.has(target))
            fail("subscription is already active");
          state.subscriptions.add(target);
        } else {
          if (!state.subscriptions.delete(target))
            fail(
              "unsubscribe requires an active subscription in this connection generation",
            );
        }
      } else if (kind === "writer-stall") {
        if (state.stalled) fail("writer is already stalled");
        state.stalled = true;
      } else if (kind === "writer-release") {
        if (!state.stalled) fail("writer-release requires a stalled writer");
        state.stalled = false;
        if (action.fail === true) state.connection = "closing";
      }
    }
    return {
      ...admitted,
      kind,
      actor,
      ...(!lifecycle
        ? {
            runtimeGeneration: 1 as const,
            connectionGeneration: state.generation,
          }
        : {}),
    };
  });
}
