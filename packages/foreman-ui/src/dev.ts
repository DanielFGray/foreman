/**
 * `bun run dev`: start the UI server Layer with fixtures and print the URL.
 * An agent opens that URL with its browser tool; the operator is not needed.
 */
import { startFixtureServer } from "./fixtures.ts";

const server = await startFixtureServer({ page: true });
console.log(`foreman-ui fixtures at ${server.url}`);
console.log("Ctrl+C to stop.");

const stop = async () => {
  await server.interrupt();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

await new Promise(() => {});
