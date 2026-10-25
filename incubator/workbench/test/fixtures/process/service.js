import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

// A small stand-in for Maven's service process, used only by ownership tests.
const mode = process.argv[2];
writeFileSync(
  new URL("started.json", import.meta.url),
  JSON.stringify({
    pid: process.pid,
    config: process.env.ZOOGLASS_VIEWS_CONFIG,
  }),
);
if (mode === "exit") process.kill(process.pid, "SIGTERM");
if (mode === "stubborn") process.on("SIGTERM", () => {});

const argument = process.argv.find((arg) => arg.includes("--server.port="));
const port = Number(argument.match(/--server.port=(\d+)/)[1]);
createServer((_request, response) => {
  response.statusCode = mode === "unhealthy" ? 503 : 200;
  response.end("{}");
}).listen(port, "127.0.0.1");
