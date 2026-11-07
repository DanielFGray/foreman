/**
 * The fixture UI server in its own process. Stopping the process closes the
 * page's WebSocket, as `foreman serve` exiting does. An in-process stop would
 * wait for the open socket: Bun's graceful stop does not end it.
 */
import { rmSync } from "node:fs";
import { startFixtureServer } from "../../src/fixtures.ts";

const [portArg, origin] = process.argv.slice(2);
if (portArg === undefined || origin === undefined) {
  throw new Error("usage: ui-server-process.ts <port> <trusted-origin>");
}

const server = await startFixtureServer({
  port: Number(portArg),
  page: true,
  trustedOrigins: [origin],
});
// SIGTERM must end the process through `exit`, so the fixture folder is removed.
process.on("SIGTERM", () => process.exit(0));
process.on("exit", () => rmSync(server.folder, { recursive: true, force: true }));
console.log(`ui-server ready ${server.port}`);
await new Promise(() => {});
