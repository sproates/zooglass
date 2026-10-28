import { randomUUID } from "node:crypto";

export interface ViewerLease {
  id: string;
  name: string;
  capability: string;
  connected: boolean;
}

/** Pairing secrets are single-use; refresh capabilities belong to one viewer lease. */
export function createViewerLeases(now = Date.now) {
  const leases = new Map<string, ViewerLease>();
  const invitations = new Map<
    string,
    { lease: ViewerLease; expires: number }
  >();
  let controllerId: string | undefined;
  let revision = 0;
  const requireLease = (id: string) => {
    const lease = leases.get(id);
    if (!lease) throw new Error("Unknown viewer.");
    return lease;
  };
  return {
    list: () =>
      [...leases.values()].map(({ id, name, connected }) => ({
        id,
        name,
        connected,
        controller: id === controllerId,
      })),
    issue(name: string, controller = false) {
      if (!name.trim() || name.length > 60)
        throw new Error("Viewer name must have 1–60 characters.");
      for (const [token, invitation] of invitations) {
        if (invitation.expires <= now()) {
          invitations.delete(token);
          leases.delete(invitation.lease.id);
        }
      }
      if (leases.size >= 8)
        throw new Error(
          "At most eight viewer leases are allowed. Revoke unused viewers.",
        );
      if (controller && controllerId && leases.has(controllerId))
        throw new Error("A controller is already designated.");
      const lease: ViewerLease = {
        id: randomUUID(),
        name,
        capability: randomUUID(),
        connected: false,
      };
      leases.set(lease.id, lease);
      const token = randomUUID();
      invitations.set(token, { lease, expires: now() + 300_000 });
      if (controller) {
        controllerId = lease.id;
        revision++;
      }
      return { id: lease.id, token };
    },
    claim(credentials: {
      pair?: unknown;
      lease?: unknown;
      capability?: unknown;
    }) {
      let lease: ViewerLease;
      if (typeof credentials.pair === "string") {
        const invitation = invitations.get(credentials.pair);
        if (!invitation || invitation.expires <= now())
          throw new Error("Pairing link is invalid or expired.");
        lease = invitation.lease;
        invitations.delete(credentials.pair);
      } else {
        lease = requireLease(String(credentials.lease));
        if (credentials.capability !== lease.capability)
          throw new Error("Invalid viewer capability.");
      }
      if (lease.connected)
        throw new Error("Viewer already has an active connection.");
      lease.connected = true;
      return lease;
    },
    disconnect(id: string) {
      const lease = leases.get(id);
      if (lease) lease.connected = false;
    },
    isController: (id: string) => id === controllerId && leases.has(id),
    authority(id: string) {
      if (id !== controllerId || !requireLease(id).connected)
        throw new Error("Only the connected controller may issue commands.");
      const admitted = revision;
      return () => {
        if (
          admitted !== revision ||
          id !== controllerId ||
          !requireLease(id).connected
        )
          throw new Error(
            "Controller authority changed before the command ran.",
          );
      };
    },
    transfer(id: string) {
      requireLease(id);
      controllerId = id;
      revision++;
    },
    revoke(id: string) {
      requireLease(id);
      leases.delete(id);
      for (const [token, invitation] of invitations)
        if (invitation.lease.id === id) invitations.delete(token);
      if (controllerId === id) {
        controllerId = undefined;
        revision++;
      }
    },
    clear() {
      leases.clear();
      invitations.clear();
      controllerId = undefined;
      revision++;
    },
  };
}
