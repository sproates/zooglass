import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

// A small stand-in for the Java service process, used only by ownership tests.
const mode = process.argv[2];
writeFileSync(
  new URL("started.json", import.meta.url),
  JSON.stringify({
    pid: process.pid,
    requestedPort: Number(
      process.argv
        .find((arg) => arg.startsWith("--server.port="))
        ?.split("=")[1],
    ),
    config: process.env.ZOOGLASS_CONFIG,
  }),
);
if (mode === "exit") {
  process.kill(process.pid, "SIGTERM");
}
if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
}

const argument = process.argv.find((arg) => arg.includes("--server.port="));
const port = Number(argument.match(/--server.port=(\d+)/)[1]);
const server = createServer((_request, response) => {
  response.statusCode = mode === "unhealthy" ? 503 : 200;
  response.end("{}");
});
server.listen(port, "127.0.0.1", () => {
  const file = process.argv
    .find((arg) => arg.startsWith("-DPORTFILE="))
    .slice("-DPORTFILE=".length);
  writeFileSync(file, String(server.address().port));
});
