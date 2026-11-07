/**
 * Node-side browser commands for the page tests. A test calls
 * `commands.startUiServer(location.origin)`, so the UI server trusts the exact
 * origin of the page vitest opened, whatever port vitest chose for it. Passing
 * the port again restarts the server where it was, for the reconnect test.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { BrowserCommand } from "vitest/node";
import type { Drawing } from "foreman/pipeline";
import { freePort } from "../../src/fixtures.ts";

const serverScript = fileURLToPath(new URL("./ui-server-process.ts", import.meta.url));

let child: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
/** The fixture folder the child writes its pipelines and drafts files into. */
let fixtureFolder: string | undefined;

/** Resolves with the child's port and folder once it prints its ready line; keeps draining stdout after that. */
const waitForReady = async (
  stdout: ReadableStream<Uint8Array>,
): Promise<{ port: number; folder: string }> => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let ready = /ui-server ready (\d+) (\S+)/.exec(text);
  while (ready === null) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`UI server process exited before it was ready:\n${text}`);
    text += decoder.decode(value);
    ready = /ui-server ready (\d+) (\S+)/.exec(text);
  }
  void (async () => {
    while (!(await reader.read()).done) {
      // drain, so the child never blocks on a full pipe
    }
  })();
  return { port: Number(ready[1]), folder: ready[2]! };
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
  const ready = await waitForReady(proc.stdout);
  child = proc;
  fixtureFolder = ready.folder;
  return ready.port;
};

export const stopUiServer: BrowserCommand<[], void> = async () => {
  if (child === undefined) return;
  child.kill();
  await child.exited;
  child = undefined;
  fixtureFolder = undefined;
};

/** A fixture file's JSON, or null when the server has not written it yet. */
const fixtureJson = async (name: string): Promise<unknown> => {
  if (fixtureFolder === undefined) throw new Error("UI server is not running");
  const file = Bun.file(join(fixtureFolder, name));
  return (await file.exists()) ? file.json() : null;
};

/** The pipeline `foreman` runs for a project, as the pipelines file holds it on disk. */
export const savedPipeline: BrowserCommand<[project: string], Drawing | null> = async (
  _context,
  project,
) => {
  const file = (await fixtureJson("pipelines.json")) as {
    pipelines: Record<string, Drawing>;
  } | null;
  return file?.pipelines[project] ?? null;
};

/** The open draft for a project, as the drafts file holds it on disk. */
export const draftPipeline: BrowserCommand<[project: string], Drawing | null> = async (
  _context,
  project,
) => {
  const file = (await fixtureJson("pipelines.draft.json")) as {
    drafts: Record<string, { pipeline: Drawing }>;
  } | null;
  return file?.drafts[project]?.pipeline ?? null;
};
