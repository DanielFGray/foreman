/**
 * Node-side browser commands for the page tests. A test calls
 * `commands.startUiServer(location.origin)`, so the UI server trusts the exact
 * origin of the page vitest opened, whatever port vitest chose for it.
 */
import type { BrowserCommand } from "vitest/node";
import { freePort, startFixtureServer, type FixtureServer } from "../../src/fixtures.ts";

let server: FixtureServer | undefined;

const waitForRpc = async (url: string): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { host: new URL(url).host } });
      // The SPA shell is enough to know Bun.build finished and routes are up.
      if (response.status === 200) return;
    } catch {
      // server not listening yet
    }
    await new Promise((ready) => setTimeout(ready, 100));
  }
  throw new Error(`UI server at ${url} did not become ready`);
};

/** Starts the UI server Layer with fixtures on a free port and returns the port. */
export const startUiServer: BrowserCommand<[origin: string], number> = async (_context, origin) => {
  const port = await freePort();
  server = await startFixtureServer({ port, page: true, trustedOrigins: [origin] });
  await waitForRpc(server.url);
  return server.port;
};

export const stopUiServer: BrowserCommand<[], void> = async () => {
  await server?.interrupt();
  server = undefined;
};
