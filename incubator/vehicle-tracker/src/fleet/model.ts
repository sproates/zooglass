export interface Vehicle {
  id: string;
  name: string;
}

export interface Position {
  sequence: number;
  latitude: number;
  longitude: number;
}

export interface Operation {
  sequence: number;
  status: "available" | "on-a-job" | "returning";
}

export type Connection =
  "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type FleetViewId = "fleet-state" | "received-journey";

export interface SnapshotState {
  subscribed: boolean;
  received: boolean;
  current: boolean;
  pending: boolean;
  position?: Position;
  operation?: Operation;
  positions?: Position[];
}

export function parseManifest(input: unknown): Vehicle[] {
  const vehicles = (input as { vehicles?: unknown } | null)?.vehicles;
  if (!Array.isArray(vehicles) || vehicles.length === 0)
    throw new Error("Fleet manifest must contain vehicles.");

  const ids = new Set<string>();
  return vehicles.map((value) => {
    if (
      !value ||
      typeof value.id !== "string" ||
      !value.id.trim() ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      ids.has(value.id)
    )
      throw new Error("Invalid or duplicate vehicle in fleet manifest.");
    ids.add(value.id);
    return { id: value.id, name: value.name };
  });
}

function position(value: unknown): Position {
  const p = value as Position | null;
  if (
    !p ||
    ![p.sequence, p.latitude, p.longitude].every(Number.isFinite) ||
    Math.abs(p.latitude) > 90 ||
    Math.abs(p.longitude) > 180
  )
    throw new Error("Invalid fleet position.");
  return { sequence: p.sequence, latitude: p.latitude, longitude: p.longitude };
}

function operation(value: unknown): Operation {
  const op = value as Operation | null;
  if (
    !op ||
    !Number.isFinite(op.sequence) ||
    !["available", "on-a-job", "returning"].includes(op.status)
  )
    throw new Error("Invalid fleet operation.");
  return { sequence: op.sequence, status: op.status };
}

/** One page's received snapshots, keyed by entity and view; selection is local. */
export function createFleetModel(vehicles: Vehicle[]) {
  const states = new Map<string, Map<FleetViewId, SnapshotState>>();
  let selected = vehicles[0].id;
  let connection: Connection = "disconnected";
  let reason: string | undefined;

  for (const vehicle of vehicles) {
    states.set(
      vehicle.id,
      new Map(
        ["fleet-state", "received-journey"].map((viewId) => [
          viewId as FleetViewId,
          {
            subscribed: false,
            received: false,
            current: false,
            pending: false,
          },
        ]),
      ),
    );
  }

  function get(viewId: string, entityId: string): SnapshotState {
    const state = states.get(entityId)?.get(viewId as FleetViewId);
    if (!state) throw new Error("Unknown fleet view or vehicle.");
    return state;
  }

  return {
    vehicles,
    get,
    get selected() {
      return selected;
    },
    get connection() {
      return connection;
    },
    get reason() {
      return reason;
    },
    select(entityId: string) {
      if (!states.has(entityId)) throw new Error("Unknown fleet vehicle.");
      selected = entityId;
    },
    setConnection(value: Connection, detail?: string) {
      connection = value;
      reason = detail;
      if (value !== "connected") {
        for (const views of states.values())
          for (const state of views.values()) {
            state.subscribed = false;
            state.current = false;
            state.pending = false;
          }
      }
    },
    subscription(
      viewId: string,
      entityId: string,
      status: "pending" | "subscribed" | "unsubscribed",
    ) {
      const state = get(viewId, entityId);
      state.subscribed = status === "subscribed";
      state.pending = status === "pending";
      state.current = false;
    },
    receive(viewId: string, entityId: string, data: unknown) {
      const state = get(viewId, entityId);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid fleet snapshot.");
      const fields = data as Record<string, unknown>;

      // Parse the complete snapshot before changing previously received state.
      if (viewId === "fleet-state") {
        const nextPosition =
          fields.position === undefined ? undefined : position(fields.position);
        const nextOperation =
          fields.operation === undefined
            ? undefined
            : operation(fields.operation);
        state.position = nextPosition;
        state.operation = nextOperation;
      } else {
        if (!Array.isArray(fields.positions))
          throw new Error("Invalid fleet history.");
        state.positions = fields.positions.map(position);
      }
      state.received = true;
      state.current = true;
    },
    status(viewId: string, entityId: string) {
      const state = get(viewId, entityId);
      if (state.current && state.subscribed && connection === "connected") {
        if (viewId === "received-journey")
          return state.positions?.length
            ? `${state.positions.length} received positions`
            : "No positions received · empty snapshot";
        return "Latest snapshot received";
      }
      if (state.received)
        return `Last received · ${connection !== "connected" ? connection : state.subscribed ? "waiting for a fresh snapshot" : "not subscribed"}`;
      if (state.pending) return "Subscribing…";
      return state.subscribed
        ? "Subscribed · waiting for first snapshot"
        : "No snapshot received";
    },
  };
}

export type FleetModel = ReturnType<typeof createFleetModel>;
