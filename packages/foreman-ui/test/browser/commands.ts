/**
 * Node-side browser commands for the page tests. A test calls
 * `commands.startUiServer(location.origin)`, so the UI server trusts the exact
 * origin of the page vitest opened, whatever port vitest chose for it. Passing
 * the port again restarts the server where it was, for the reconnect test.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { BrowserCommand } from "vitest/node";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { readDrafts, updateDrafts } from "foreman/pipeline-draft";
import { readPipelines } from "foreman/pipeline-file";
import { type Drawing, DEFAULT_PIPELINE } from "foreman/pipeline";
import type { Policy } from "foreman/policy";
import { readPolicy } from "foreman/policy-file";
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
  let ready = readyIn(text);
  while (ready === undefined) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`UI server process exited before it was ready:\n${text}`);
    text += decoder.decode(value);
    ready = readyIn(text);
  }
  void (async () => {
    while (!(await reader.read()).done) {
      // drain, so the child never blocks on a full pipe
    }
  })();
  return ready;
};

/** The port and folder on the child's ready line, once the line is there. */
const readyIn = (text: string): { port: number; folder: string } | undefined => {
  const [, port, folder] = /ui-server ready (\d+) (\S+)/.exec(text) ?? [];
  return port === undefined || folder === undefined ? undefined : { port: Number(port), folder };
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

/**
 * Removes a block from a project's open draft in the drafts file, as another
 * process writing the file would. The UI server then holds no such block, and
 * an edit that names it is refused.
 */
export const removeDraftBlock: BrowserCommand<[project: string, block: string], void> = (
  _context,
  project,
  block,
) =>
  onFixtures((folder) =>
    updateDrafts(join(folder, "pipelines.draft.json"), (drafts) => {
      // With no draft open, the page shows the default pipeline, and so does the server's fresh draft.
      const draft = drafts[project] ?? {
        base: null,
        pipeline: DEFAULT_PIPELINE,
        composites: {},
        bases: {},
      };
      const nodes = draft.pipeline.nodes.filter((node) => node.id !== block);
      return { ...drafts, [project]: { ...draft, pipeline: { nodes } } };
    }).pipe(Effect.asVoid),
  );

/** The pipeline `foreman` runs for a project, as the pipelines file holds it on disk. */
export const savedPipeline: BrowserCommand<[project: string], Drawing | null> = (
  _context,
  project,
) =>
  onFixtures((folder) =>
    readPipelines(join(folder, "pipelines.json")).pipe(
      Effect.map((read) => read.value.pipelines[project] ?? null),
    ),
  );

/** The open draft for a project, as the drafts file holds it on disk. */
export const draftPipeline: BrowserCommand<[project: string], Drawing | null> = (
  _context,
  project,
) =>
  onFixtures((folder) =>
    readDrafts(join(folder, "pipelines.draft.json")).pipe(
      Effect.map((read) => read.value[project]?.pipeline ?? null),
    ),
  );

/** The policy the UI server wrote, as the dispatcher would read it: the default when there is no file yet. */
export const storedPolicy: BrowserCommand<[], Policy> = () =>
  onFixtures((folder) =>
    readPolicy(join(folder, "policy.json")).pipe(Effect.map((read) => read.policy)),
  );

/**
 * Reads or rewrites a file in the folder the UI server writes, through
 * foreman's own readers, so a fixture decodes as the dispatcher decodes it.
 */
const onFixtures = <A, E>(use: (folder: string) => Effect.Effect<A, E, BunServices.BunServices>) =>
  fixtureFolder === undefined
    ? Promise.reject(new Error("UI server is not running"))
    : Effect.runPromise(use(fixtureFolder).pipe(Effect.provide(BunServices.layer)));
