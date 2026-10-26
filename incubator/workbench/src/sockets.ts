const connectionTimeoutMs = 10_000;

const closeTimeoutMs = 3_000;

export const messagesBySocket = new WeakMap<WebSocket, unknown[]>();

export async function connectClient(
  url: string,
  signal: AbortSignal,
): Promise<WebSocket> {
  signal.throwIfAborted();

  const socket = new WebSocket(url);
  const messages: unknown[] = [];

  messagesBySocket.set(socket, messages);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      messages.push(event.data);
      return;
    }

    try {
      messages.push(JSON.parse(event.data) as unknown);
    } catch {
      messages.push(event.data);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", aborted);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };

      const opened = () => {
        clean();
        resolve();
      };

      const failed = () => {
        clean();
        reject(new Error(`Could not connect to ${url}.`));
      };

      const aborted = () => {
        clean();
        reject(signal.reason);
      };

      const timeout = setTimeout(() => {
        clean();
        reject(new Error(`Timed out connecting to ${url}.`));
      }, connectionTimeoutMs);

      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
      signal.addEventListener("abort", aborted, { once: true });
    });
    return socket;
  } catch (error) {
    await closeClient(socket);
    throw error;
  }
}

export function closeClient(socket: WebSocket | undefined): Promise<void> {
  if (socket === undefined || socket.readyState === WebSocket.CLOSED)
    return Promise.resolve();

  return new Promise((resolve, reject) => {
    const closed = () => {
      clearTimeout(timeout);
      resolve();
    };

    const timeout = setTimeout(() => {
      socket.removeEventListener("close", closed);
      reject(new Error("Timed out closing a WebSocket connection."));
    }, closeTimeoutMs);

    socket.addEventListener("close", closed, { once: true });
    socket.close();
  });
}

/** Attempt every cleanup even when one resource fails to close. */
export async function closeAll(operations: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  if (errors.length > 0)
    throw new AggregateError(errors, "Session cleanup failed.");
}
