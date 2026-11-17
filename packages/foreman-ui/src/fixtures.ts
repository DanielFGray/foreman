/**
 * Fixed readings and a UI server Layer for `bun run dev` and the page tests.
 * Mirrors the fake Fleet / scratch store pattern in foreman's ui-server tests.
 */
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, Layer, Option, SubscriptionRef } from "effect";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_FLEET } from "../../foreman/src/dispatcher.ts";
import { Fleet, type Worker } from "../../foreman/src/fleet.ts";
import { FleetError } from "../../foreman/src/errors.ts";
import { Settings } from "../../foreman/src/config.ts";
import { publishedOf } from "../../foreman/src/published.ts";
import type { Published, PublishedRow } from "foreman/published-schema";
import { Records } from "../../foreman/src/records.ts";
import { STANDARD_PIPELINES } from "../../foreman/src/pipeline.ts";
import { Repository } from "../../foreman/src/repository.ts";
import { scratchStore, seed } from "../../foreman/src/scratch-store.ts";
import { ReadingsRef, serveGate, uiServerOn, type UiServerOptions } from "foreman/ui-server";
import { offlineHost } from "../../foreman/src/offline-host.ts";

/** A free TCP port on 127.0.0.1. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("freePort: no address"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

/** Sample reading with two projects and one row, for the page and its tests. */
export const fixtureReading = (): Published => {
  const base = publishedOf(
    {
      ...EMPTY_FLEET,
      projects: [
        {
          name: "amux",
          directory: "/tmp/amux",
          verify: undefined,
          preview: undefined,
          open: true,
        },
        {
          name: "foreman",
          directory: "/tmp/foreman",
          verify: undefined,
          preview: undefined,
          open: true,
        },
      ],
    },
    Option.some({ state: "idle" as const }),
  );
  return {
    ...base,
    rows: [
      fixtureRow("working", "ts-demo", "Wire the page", ["focus", "kill", "release"]),
      fixtureRow("attention", "ts-ask", "asks  Land the page", ["approve"]),
      fixtureRow("landed", "ts-old", "Read the store once", []),
    ],
  };
};

const fakeFleet = Layer.succeed(
  Fleet,
  Fleet.of({
    open: () => Effect.fail(new FleetError({ operation: "open", detail: "unused" })),
    attach: () => Effect.fail(new FleetError({ operation: "attach", detail: "unused" })),
    spawn: () => Effect.fail(new FleetError({ operation: "spawn", detail: "unused" })),
    roster: Effect.succeed([] as ReadonlyArray<Worker>),
    awaitTurn: () => Effect.void,
    spaces: Effect.succeed([] as ReadonlyArray<string>),
    say: () => Effect.void,
    screen: () => Effect.succeedNone,
    preview: () => Effect.succeed("preview"),
    focus: () => Effect.void,
    stop: () => Effect.void,
    close: () => Effect.void,
    notify: () => Effect.void,
    inWorker: Effect.succeed(false),
  }),
);

const testSettings = Layer.succeed(
  Settings,
  Settings.of({
    otlpEndpoint: "http://localhost:4318",
    pollInterval: 60,
    staleAfter: 24,
    coachWindow: 60,
    stallGrace: 5,
    landedWindow: 7,
    attemptsPerLevel: 2,
  }),
);

export type FixtureServer = {
  readonly port: number;
  readonly url: string;
  readonly reading: Published;
  /** Stops the Layer, then removes the scratch store and folder. */
  readonly interrupt: () => Promise<void>;
  /** Removes the scratch store and folder without stopping the Layer; for a process that is exiting. */
  readonly cleanup: () => void;
  readonly folder: string;
};

/**
 * Starts the UI server Layer on a free port with fixture readings and a scratch
 * store. The caller ends it with `interrupt`, or with `cleanup` when the process
 * exits.
 */
export const startFixtureServer = async (options?: {
  readonly port?: number;
  readonly trustedOrigins?: ReadonlyArray<string>;
  readonly page?: boolean;
}): Promise<FixtureServer> => {
  const folder = mkdtempSync(join(tmpdir(), "foreman-ui-fixtures-"));
  process.env["FOREMAN_PIPELINES"] = join(folder, "pipelines.json");
  // amux has drawn the checkout pipeline, which the editor's tests edit; foreman
  // has drawn none, so it runs the empty one.
  writeFileSync(
    join(folder, "pipelines.json"),
    JSON.stringify({ pipelines: { amux: STANDARD_PIPELINES.checkout } }),
  );
  process.env["XDG_CONFIG_HOME"] = folder;
  process.env["FOREMAN_POLICY"] = join(folder, "policy.json");

  const store = scratchStore();
  await Effect.runPromise(
    seed(`
      INSERT INTO pools (pool, harness, provider_default) VALUES ('Pool', 'pi', 'prov');
      INSERT INTO models (model, provider, pool, harness, limit_scope) VALUES ('m1', 'prov', 'Pool', 'pi', 'pool');
      INSERT INTO ladder (rank, level, rung, model) VALUES (1, 1, 'cheap', 'm1');
      INSERT INTO items (id, project, type, title, status, priority, parent_id) VALUES
        ('ep-graph', 'amux', 'epic', 'Draw the task graph', 'in_progress', 2, NULL),
        ('ts-g1', 'amux', 'task', 'Place each item one past its blockers', 'open', 1, 'ep-graph'),
        ('ts-g2', 'amux', 'task', 'Fold an epic into one card', 'open', 2, 'ep-graph'),
        ('ts-g3', 'amux', 'task', 'Send picked cards through', 'open', 2, NULL),
        ('ts-g4', 'amux', 'task', 'Read the store once', 'done', 2, NULL);
      INSERT INTO deps (item_id, depends_on) VALUES
        ('ts-g2', 'ts-g1'), ('ts-g3', 'ts-g2'), ('ts-g1', 'ts-g4');
    `).pipe(Effect.provide(store.layer)),
  );

  const reading = fixtureReading();
  const readings = Layer.effect(ReadingsRef, SubscriptionRef.make(reading));
  const services = Layer.mergeAll(
    Records.layer,
    testSettings,
    Repository.Default,
    fakeFleet,
    offlineHost,
  ).pipe(Layer.provideMerge(BunServices.layer), Layer.provideMerge(store.registry));
  const handlers = Layer.mergeAll(readings, services);

  const port = options?.port ?? (await freePort());
  const gate = serveGate(port);
  const serverOptions: UiServerOptions = {
    gate: { ...gate, origins: options?.trustedOrigins ?? gate.origins },
    page: options?.page,
  };

  const fiber = Effect.runFork(
    Layer.launch(uiServerOn(port, serverOptions).pipe(Layer.provide(handlers))),
  );

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { host: `127.0.0.1:${port}` } });
      if (response.status === 200 || response.status === 404) break;
    } catch {
      // not listening yet (page build may still be running)
    }
    await new Promise((ready) => setTimeout(ready, 100));
  }

  const cleanup = () => {
    store.cleanup();
    rmSync(folder, { recursive: true, force: true });
  };
  return {
    port,
    url,
    reading,
    folder,
    cleanup,
    interrupt: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
      cleanup();
    },
  };
};

/** A row of the fixture reading in project amux. */
const fixtureRow = (
  view: PublishedRow["view"],
  key: string,
  label: string,
  actions: ReadonlyArray<string>,
): PublishedRow => ({
  view,
  key,
  label,
  detail: null,
  project: "amux",
  parent: null,
  epic: false,
  actions,
  url: null,
  pr: null,
});
