import type { Agenda } from "./agenda.js";
import type { Json } from "./json.js";
import { metadataJson } from "./semantic-trace.js";

export type LinkConnection = {
  actor: string;
  session: string;
  generation: number;
  open: boolean;
};
export type LinkChannel =
  "source-publication" | "source-receipt" | "client-request" | "client-frame";
type Packet = {
  connection: LinkConnection;
  channel: LinkChannel;
  envelope: Json;
  messageId: string;
  sent: string;
  lossCause?: string;
};
type Ports = {
  agenda: Agenda;
  event: (
    kind: string,
    data: Json,
    parent: string,
    connection: LinkConnection,
    causes?: string[],
  ) => string;
  turn: () => void;
  checkBound: () => void;
};

/** Fixed-latency directional FIFO queues, scoped to actual connection generations. */
export class DelayedLinks {
  private readonly packets = new Map<number, Packet>();
  constructor(private readonly ports: Ports) {}
  send(
    connection: LinkConnection,
    channel: LinkChannel,
    envelope: Json,
    messageId: string,
    latency: number,
    parent: string,
    deliver: (arrival: string) => Promise<void>,
    lossCause?: string,
  ) {
    const deliverAtMs = this.ports.agenda.current[0] + latency;
    const sent = this.ports.event(
      "link-send",
      {
        envelope,
        ...(metadataJson({ messageId, channel, deliverAtMs }) as {
          [key: string]: Json;
        }),
      },
      parent,
      connection,
    );
    const id = this.ports.agenda.allocateModelTask();
    const packet = {
      connection,
      channel,
      envelope,
      messageId,
      sent,
      lossCause,
    };
    this.packets.set(id, packet);
    this.ports.checkBound();
    this.ports.agenda.add(
      deliverAtMs,
      2,
      async () => {
        this.packets.delete(id);
        this.ports.turn();
        if (!connection.open || lossCause) {
          this.drop(packet, sent);
          return;
        }
        const arrival = this.ports.event(
          "delivered",
          this.data(packet),
          sent,
          connection,
        );
        await deliver(arrival);
      },
      id,
    );
  }
  private data(packet: Packet): { [key: string]: Json } {
    return {
      envelope: packet.envelope,
      ...(metadataJson({
        messageId: packet.messageId,
        channel: packet.channel,
      }) as { [key: string]: Json }),
    };
  }
  private drop(packet: Packet, parent: string) {
    this.ports.event(
      "dropped",
      {
        ...this.data(packet),
        reason: packet.lossCause ? "receipt-loss" : "connection-closed",
      },
      parent,
      packet.connection,
      [packet.sent, ...(packet.lossCause ? [packet.lossCause] : [])],
    );
  }
  close(connection: LinkConnection, cause: string) {
    for (const [id, packet] of this.packets) {
      if (packet.connection.session !== connection.session) continue;
      this.ports.agenda.cancel(id);
      this.packets.delete(id);
      this.drop(packet, cause);
    }
  }
  pending() {
    return this.packets.size;
  }
}
