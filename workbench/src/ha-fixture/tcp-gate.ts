import net, { type Socket } from "node:net";
/** An actual TCP partition: existing streams close and new connections fail while cut. */
export class TcpGate {
  private readonly sockets = new Set<Socket>();
  private cut = false;
  private readonly server = net.createServer((client) => {
    if (this.cut) {
      client.destroy();
      return;
    }
    const upstream = net.connect(this.targetPort, this.targetHost);
    this.track(client);
    this.track(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}
  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  }
  async listen(port = 0, host = "127.0.0.1"): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    return (this.server.address() as net.AddressInfo).port;
  }
  partition(cut: boolean): void {
    this.cut = cut;
    if (cut) for (const socket of this.sockets) socket.destroy();
  }
  async close(): Promise<void> {
    this.partition(true);
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
