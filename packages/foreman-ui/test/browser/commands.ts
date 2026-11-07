/**
 * Node-side browser commands for the page tests. A test calls
 * `commands.startUiServer(location.origin)`, so the UI server trusts the exact
 * origin of the page vitest opened, whatever port vitest chose for it. Passing
 * the port again restarts the server where it was, for the reconnect test.
 */
import { fileURLToPath } from "node:url";
import type { BrowserCommand } from "vitest/node";
import { freePort } from "../../src/fixtures.ts";

const serverScript = fileURLToPath(new URL("./ui-server-process.ts", import.meta.url));

let child: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;

/** Resolves once the child prints its ready line; keeps draining stdout after that. */
const waitForReady = async (stdout: ReadableStream<Uint8Array>): Promise<void> => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("ui-server ready")) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`UI server process exited before it was ready:\n${text}`);
    text += decoder.decode(value);
  }
  void (async () => {
    while (!(await reader.read()).done) {
      // drain, so the child never blocks on a full pipe
    }
  })();
};

/** Starts the UI server in a child process and returns its port. */
export const startUiServer: BrowserCommand<[origin: string, port?: number], number> = async (
  _context,
  origin,
  port,
) => {
  if (child !== undefined) throw new Error("UI server is already running");
  const listenPort = port ?? (await freePort());
  const proc = Bun.spawn([process.execPath, serverScript, String(listenPort), origin], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  await waitForReady(proc.stdout);
  child = proc;
  return listenPort;
};

export const stopUiServer: BrowserCommand<[], void> = async () => {
  if (child === undefined) return;
  child.kill();
  await child.exited;
  child = undefined;
};
