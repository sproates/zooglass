interface PlaybackState {
  kind: "state";
  generation: number;
  phase: string;
  playing: boolean;
  completed: number;
  total: number;
  detail: string;
  checkpoint?: string;
  next: string;
}

/** Controls operate the shared walkthrough; they never supply order view values. */
export function connectControls(
  onRun: (generation: number, available: boolean) => void,
) {
  const panel = document.getElementById("playback")!;
  panel.hidden = false;
  const button = (name: string) =>
    document.getElementById(name) as HTMLButtonElement;
  const buttons = ["step", "play", "pause", "reset"].map(button);
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let state: PlaybackState | undefined;
  let active = true;
  const disable = () =>
    buttons.forEach((button) => {
      button.disabled = true;
    });
  function connect() {
    clearTimeout(retry);
    socket?.close();
    disable();
    if (!active || document.hidden) return;
    const url = new URL("/controls", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(url);
    socket = current;
    current.onmessage = (event) => {
      if (socket !== current) return;
      const message = JSON.parse(event.data);
      if (message.kind === "error") {
        document.getElementById("control-detail")!.textContent = message.detail;
        return;
      }
      if (message.kind !== "state") return;
      state = message;
      const value = state!;
      const ready = value.phase === "ready" && !value.playing;
      button("step").disabled = !ready;
      button("play").disabled = !ready;
      button("pause").disabled = !value.playing;
      button("reset").disabled = ["starting", "resetting", "closed"].includes(
        value.phase,
      );
      document.getElementById("checkpoint-label")!.textContent =
        `${value.completed}/${value.total} checked · ${value.checkpoint ?? value.next}`;
      document.getElementById("control-detail")!.textContent = value.detail;
      onRun(
        value.generation,
        !["starting", "resetting", "closed"].includes(value.phase),
      );
    };
    current.onclose = () => {
      if (socket !== current) return;
      disable();
      document.getElementById("control-detail")!.textContent =
        "Controls disconnected; reconnecting. View data uses a separate connection.";
      if (active && !document.hidden) retry = setTimeout(connect, 1500);
    };
    current.onerror = () => current.close();
  }
  for (const element of buttons)
    element.addEventListener("click", () => {
      if (socket?.readyState === WebSocket.OPEN && state)
        socket.send(
          JSON.stringify({ action: element.id, generation: state.generation }),
        );
    });
  const retire = () => {
    clearTimeout(retry);
    const old = socket;
    socket = undefined;
    old?.close();
    disable();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) retire();
    else connect();
  });
  window.addEventListener("pagehide", () => {
    active = false;
    retire();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      active = true;
      connect();
    }
  });
  connect();
}
