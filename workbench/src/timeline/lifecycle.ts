import type { Json } from "./json.js";
import { integer, invalid, list, object, text } from "./validation.js";

export type AdmittedAction = {
  id: string;
  actor: string;
  atMs: number;
  phase: 0 | 2;
  declaration: number;
  runtimeGeneration: 1;
  connectionGeneration: number;
};
type ActorState = {
  connection: "disconnected" | "connected" | "closing";
  generation: number;
  stalled: boolean;
  subscriptions: Set<string>;
  sent: Set<string>;
};

/** Admit declared controls, not runtime-derived closes or successful publications. */
export function admitLifecycle(doc: { [key: string]: Json }): AdmittedAction[] {
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
      const kind = text(action.kind, `${path}.kind`);
      const phase: 0 | 2 = [
        "connect",
        "disconnect",
        "writer-stall",
        "writer-release",
      ].includes(kind)
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
  return actions.map(({ action, path, kind, phase, declaration, atMs }) => {
    const actor = text(action.actor, `${path}.actor`);
    const state = states.get(actor)!;
    const fail = (reason: string): never => invalid(path, reason);
    if (kind === "connect") {
      if (state.connection !== "disconnected")
        fail("connect requires a disconnected actor");
      state.connection = "connected";
      state.generation++;
    } else if (kind === "disconnect") {
      if (state.connection === "disconnected")
        fail("disconnect requires a connected or closing actor");
      state.connection = "disconnected";
      state.stalled = false;
      state.subscriptions.clear();
    } else {
      if (state.connection !== "connected")
        fail(`${kind} requires a connected actor`);
      if (kind.startsWith("source-")) {
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
      id: text(action.id, `${path}.id`),
      actor,
      atMs,
      phase,
      declaration,
      runtimeGeneration: 1,
      connectionGeneration: state.generation,
    };
  });
}
