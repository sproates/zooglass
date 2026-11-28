import { Ownership } from "./ownership.js";
import { decode, ProtocolFailure, type ObjectValue } from "./protocol.js";
import { Episode, terminal, type RecoveryBounds } from "./recovery.js";
import {
  byteBound,
  trustedOrigins,
  type Channel,
  type Transport,
} from "./transport.js";
import {
  ViewerState,
  resourceKey,
  type Resource,
  type ViewerEvent,
} from "./viewer-state.js";

export interface ViewerSettings extends RecoveryBounds {
  origins: readonly string[];
  transport: Transport;
  ownership: Ownership;
  maxBytes: number;
  maxResources: number;
  onEvent: (event: ViewerEvent) => void;
  onUnavailable?: (error: Error) => void;
}
interface PendingCommand {
  resolve: (accepted: boolean) => void;
  reject: (error: Error) => void;
  cancel: () => void;
  refused: boolean;
}

/** One bounded reconnect loop, with a shared ownership watermark and no retained frame history. */
export class HaViewer {
  readonly state: ViewerState;
  private readonly origins: string[];
  private readonly limit: number;
  private readonly stop = new AbortController();
  private readonly desired = new Map<string, Resource>();
  private readonly http = new Map<string, AbortController>();
  private channel?: Channel;
  private generation?: bigint;
  private command?: PendingCommand;
  private task?: Promise<void>;
  private readonly removeObserver: () => void;
  private readonly settings: ViewerSettings;
  constructor(settings: ViewerSettings) {
    this.settings = Object.freeze({
      ...settings,
      origins: Object.freeze([...settings.origins]),
    });
    settings = this.settings;
    this.origins = trustedOrigins(settings.origins);
    this.limit = byteBound(settings.maxBytes);
    new Episode(settings);
    this.state = new ViewerState(
      settings.ownership,
      settings.maxResources,
      (event) => {
        if (event.type === "refused") {
          const key = resourceKey(event.resource);
          this.desired.delete(key);
          this.http.get(key)?.abort(new Error("Resource admission refused"));
          this.http.delete(key);
          this.state.forget(event.resource);
          if (this.command) {
            this.command.refused = true;
          }
        }
        settings.onEvent(event);
      },
    );
    this.removeObserver = settings.ownership.listen(() => {
      if (settings.ownership.signal.aborted) {
        this.stop.abort(settings.ownership.signal.reason);
        this.retire(settings.ownership.signal.reason as Error);
        return;
      }
      if (
        this.generation !== undefined &&
        this.generation < settings.ownership.generation
      ) {
        this.channel?.close();
      }
    });
  }
  start(resources: readonly Resource[] = []): Promise<void> {
    this.settings.ownership.assertAvailable();
    if (this.task || this.stop.signal.aborted) {
      throw new Error("Viewer already started or closed");
    }
    for (const resource of resources) {
      this.remember(resource);
    }
    let resolve!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.task = this.run(resolve).catch((error: Error) => {
      reject(error);
      if (!this.stop.signal.aborted) {
        this.settings.onUnavailable?.(error);
      }
    });
    return started;
  }
  private remember(resource: Resource): void {
    const key = resourceKey(resource);
    if (
      !this.desired.has(key) &&
      this.desired.size >= this.settings.maxResources
    ) {
      throw new Error("Desired resource capacity exceeded");
    }
    if (!resource.viewId || !resource.entityId) {
      throw new Error("Resource identifiers are required");
    }
    this.desired.set(key, {
      viewId: resource.viewId,
      entityId: resource.entityId,
    });
  }
  async subscribe(resource: Resource): Promise<boolean> {
    if (!this.channel || !this.state.ready || this.command) {
      throw new Error("Viewer is not ready for another command");
    }
    const key = resourceKey(resource),
      existed = this.desired.has(key);
    this.remember(resource);
    try {
      return this.sendCommand(
        "subscribe",
        resource,
        new Episode(this.settings),
      );
    } catch (error) {
      if (!existed) this.desired.delete(key);
      throw error;
    }
  }
  async unsubscribe(resource: Resource): Promise<void> {
    if (!this.channel || this.command) {
      throw new Error("Viewer is not ready for another command");
    }
    await this.sendCommand("unsubscribe", resource, new Episode(this.settings));
    this.desired.delete(resourceKey(resource));
    this.state.forget(resource);
  }
  private sendCommand(
    action: "subscribe" | "unsubscribe",
    resource: Resource,
    episode: Episode,
  ): Promise<boolean> {
    if (!this.channel || this.command) {
      throw new Error("Only one pending command is permitted");
    }
    const raw = this.state.command(action, resource),
      signal = episode.signal(this.stop.signal);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.command = undefined;
        this.channel?.close();
        reject(signal.reason);
      };
      this.command = {
        resolve,
        reject,
        cancel: () => signal.removeEventListener("abort", abort),
        refused: false,
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.channel!.send(raw);
      } catch (error) {
        this.command.cancel();
        this.command = undefined;
        reject(error);
        this.channel?.close();
      }
    });
  }
  private async receive(
    channel: Channel,
    token: object,
    signal: AbortSignal,
  ): Promise<never> {
    for (;;) {
      const raw = await channel.next(signal);
      if (!this.state.isCurrent(token)) {
        throw new Error("Connection retired");
      }
      this.state.receive(token, decode(raw, this.limit));
      if (this.command && !this.state.commandPending) {
        const pending = this.command;
        this.command = undefined;
        pending.cancel();
        pending.resolve(!pending.refused);
      }
    }
  }
  private retire(error: Error): void {
    this.channel?.close();
    this.channel = undefined;
    this.generation = undefined;
    if (this.command) {
      const pending = this.command;
      this.command = undefined;
      pending.cancel();
      pending.reject(error);
    }
    for (const read of this.http.values()) {
      read.abort(error);
    }
    this.http.clear();
    this.state.retire();
  }
  private async run(initialReady: () => void): Promise<void> {
    let episode = new Episode(this.settings),
      attempt = 0;
    let last: Error = new Error("Recovery deadline exhausted");
    while (!this.stop.signal.aborted && episode.remaining()) {
      let reader: Promise<never> | undefined;
      let failure: Error | undefined;
      const lifetime = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, this.stop.signal]);
      try {
        this.retire(new Error("New connection attempt"));
        const token = this.state.token;
        this.channel = await this.settings.transport.connect(
          this.origins[attempt % this.origins.length],
          "/views/live",
          episode.signal(signal),
        );
        const hello = decode(
          await this.channel.next(episode.signal(signal)),
          this.limit,
        );
        if ("error" in hello || hello.kind !== "hello") {
          throw new ProtocolFailure("Expected viewer hello");
        }
        this.generation = hello.generation;
        this.state.receive(token, hello);
        reader = this.receive(this.channel, token, signal);
        // A reader failure must reject an outstanding baseline wait immediately.
        void reader.catch((error: Error) => {
          failure = error;
          this.retire(error);
        });
        for (const resource of [...this.desired.values()]) {
          await this.sendCommand("subscribe", resource, episode);
        }
        if (failure) {
          throw failure;
        }
        initialReady();
        // A new outage, after successful recovery, gets its own bounded episode.
        try {
          await reader;
        } finally {
          episode = new Episode(this.settings);
          attempt = 0;
        }
      } catch (error) {
        last =
          failure ??
          (error instanceof Error ? error : new Error("Viewer failed"));
        if (terminal(last)) {
          throw last;
        }
      } finally {
        lifetime.abort(new Error("Attempt finished"));
        this.retire(last);
        await reader?.catch(() => {});
      }
      if (this.stop.signal.aborted) {
        break;
      }
      try {
        await episode.backoff(attempt++, this.stop.signal);
      } catch {
        break;
      }
    }
    throw last;
  }
  async read(resource: Resource): Promise<ObjectValue | null | undefined> {
    if (this.stop.signal.aborted) {
      throw new Error("Viewer closed");
    }
    const key = resourceKey(resource);
    const ticket = this.state.beginRead(resource);
    this.http.get(key)?.abort(new Error("Read superseded"));
    const controller = new AbortController();
    this.http.set(key, controller);
    const signal = AbortSignal.any([controller.signal, this.stop.signal]);
    const episode = new Episode(this.settings);
    let attempt = 0,
      last: unknown = new Error("Read deadline exhausted");
    try {
      while (episode.remaining() && !signal.aborted) {
        try {
          const response = await this.settings.transport.read(
            this.origins[attempt % this.origins.length],
            `/views?${new URLSearchParams({ viewId: resource.viewId, entityId: resource.entityId })}`,
            episode.signal(signal),
          );
          if (!this.state.readIsCurrent(ticket)) {
            return undefined;
          }
          const frame = decode(response.body, this.limit);
          if (
            "error" in frame ||
            (response.status === 200
              ? frame.kind !== "snapshot"
              : response.status !== 404 || frame.kind !== "notFound")
          ) {
            throw new ProtocolFailure("Invalid snapshot response");
          }
          return this.state.finishRead(ticket, frame);
        } catch (error) {
          if (!this.state.readIsCurrent(ticket)) {
            return undefined;
          }
          last = error;
          if (terminal(error)) {
            throw error;
          }
        }
        try {
          await episode.backoff(attempt++, signal);
        } catch {
          break;
        }
      }
      if (signal.aborted && !this.state.readIsCurrent(ticket)) {
        return undefined;
      }
      throw last;
    } finally {
      if (this.http.get(key) === controller) {
        this.http.delete(key);
      }
    }
  }
  async close(): Promise<void> {
    this.stop.abort(new Error("Viewer cancelled"));
    this.retire(new Error("Viewer closed"));
    await this.task;
    this.state.close();
    this.removeObserver();
  }
}
