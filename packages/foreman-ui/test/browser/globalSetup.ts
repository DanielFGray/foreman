/**
 * Starts the UI server Layer on a free port with fixtures, trusting vitest's
 * browser-page origin (any loopback http Origin — vitest may pick a free
 * tester port), and provides the port to the browser tests. The React page
 * under test is served by vitest; the Layer answers the contract over WebSocket.
 */
import { LOOPBACK_HTTP, serveOrigins } from "foreman/ui-server";
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

export async function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  const port = await freePort();
  server = await startFixtureServer({
    port,
    page: true,
    trustedOrigins: [...serveOrigins(port), LOOPBACK_HTTP],
  });
  await waitForRpc(server.url);
  provide("uiPort", server.port);
  provide("uiUrl", server.url);
}

export async function teardown() {
  await server?.interrupt();
  server = undefined;
}
