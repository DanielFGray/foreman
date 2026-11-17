import { SqlClient } from "effect/sql";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices, BunSocket } from "@effect/platform-bun";
import {
  ConfigProvider,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization, RpcTest } from "effect/rpc";
import { Command } from "effect/cli";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "./config.ts";
import { EMPTY_FLEET, Dispatcher } from "./dispatcher.ts";
import { Fleet, type Worker } from "./fleet.ts";
import { FleetError } from "./errors.ts";
import { publishedOf } from "./published.ts";
import { pipelineCommand as pipelineCommandWith } from "./pipeline-command.ts";
import { Records } from "./records.ts";
import { Repository } from "./repository.ts";
import { scratchStore, seed } from "./scratch-store.ts";
import { STANDARD_PIPELINES } from "./pipeline.ts";
import { UiContract } from "./ui-contract.ts";
import { GRAPH_STATUSES } from "./pipeline-graph-view.ts";
import type { TaskState } from "tasks/item";
import { resolve } from "./paths.ts";
import { offlineHost } from "./offline-host.ts";
import {
  buildPageAssets,
  admits,
  type Gate,
  ReadingsRef,
  resolvePageEntrypoint,
  serveGate,
  uiHandlersLayer,
  uiRoutesLayer,
  uiHosts,
  uiServerOn,
} from "./ui-server.ts";

const folder = mkdtempSync(join(tmpdir(), "foreman-ui-server-"));
const path = join(folder, "pipelines.json");
process.env["FOREMAN_PIPELINES"] = path;
process.env["XDG_CONFIG_HOME"] = folder;
process.env["FOREMAN_POLICY"] = join(folder, "policy.json");
const store = scratchStore();
// The open space: a git checkout, so a one-shot read finds the project `actp`
// and gives its queued task a row.
const checkout = join(folder, "actp");
mkdirSync(checkout);
for (const args of [
  ["init", "-q"],
  [
    "-c",
    "user.email=foreman@test",
    "-c",
    "user.name=foreman",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "initial",
  ],
]) {
  Bun.spawnSync(["git", "-C", checkout, ...args]);
}
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
  store.cleanup();
});
const drafts = join(folder, "pipelines.draft.json");
beforeEach(() => {
  rmSync(path, { force: true });
  rmSync(drafts, { force: true });
});

await Effect.runPromise(
  seed(`
    INSERT INTO pools (pool, harness, provider_default) VALUES ('Pool', 'pi', 'prov');
    INSERT INTO models (model, provider, pool, harness, limit_scope) VALUES ('m1', 'prov', 'Pool', 'pi', 'pool');
    INSERT INTO ladder (rank, level, rung, model) VALUES (1, 1, 'cheap', 'm1');
    INSERT INTO items (id, project, type, title, status, parent_id) VALUES
      ('ep-g', 'graphp', 'epic', 'Graph epic', 'in_progress', NULL),
      ('ts-a', 'graphp', 'task', 'First', 'open', 'ep-g'),
      ('ts-b', 'graphp', 'task', 'Second', 'open', NULL),
      ('ts-d', 'graphp', 'task', 'Landed', 'done', NULL),
      ('ts-q', 'actp', 'task', 'Queued', 'open', NULL);
    INSERT INTO deps (item_id, depends_on) VALUES ('ts-b', 'ts-a'), ('ts-b', 'ts-d');
  `).pipe(Effect.provide(store.layer)),
);

/** A Fleet that answers spaces and refuses every other call — verbs under test do not dispatch. */
const fakeFleet = Layer.succeed(
  Fleet,
  Fleet.of({
    open: () => Effect.fail(new FleetError({ operation: "open", detail: "unused" })),
    attach: () => Effect.fail(new FleetError({ operation: "attach", detail: "unused" })),
    spawn: () => Effect.fail(new FleetError({ operation: "spawn", detail: "unused" })),
    roster: Effect.succeed([] as ReadonlyArray<Worker>),
    awaitTurn: () => Effect.void,
    spaces: Effect.succeed([checkout]),
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

const fixedReadings = Layer.effect(
  ReadingsRef,
  SubscriptionRef.make(publishedOf(EMPTY_FLEET, Option.none())),
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

/**
 * Handlers over a temporary store, fixed readings, and a fake Fleet. Records
 * and Settings cover Queue/simulate/graph; PipelineEdit under test only needs
 * the registry and files.
 */
const services = Layer.mergeAll(
  Records.layer,
  testSettings,
  Repository.Default,
  fakeFleet,
  offlineHost,
).pipe(Layer.provideMerge(BunServices.layer), Layer.provideMerge(store.registry));
const handlers = uiHandlersLayer.pipe(Layer.provideMerge(fixedReadings), Layer.provide(services));

const pipelineCommand = pipelineCommandWith(
  Layer.effect(Dispatcher, Effect.die("ui tests do not run pipeline place")),
);

const platform = Layer.merge(BunServices.layer, store.registry);

const runPipeline = (...args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(pipelineCommand, { version: "test" })(args).pipe(Effect.provide(platform)),
  );

const change = {
  _tag: "Configure" as const,
  id: "author",
  setting: {
    kind: "agent" as const,
    role: "author" as const,
    model: "cheap",
    slots: undefined,
    vars: undefined,
  },
};

const pinned = {
  nodes: STANDARD_PIPELINES.worktree.nodes.map((node) =>
    node.id === "author" ? { ...node, model: "cheap" } : node,
  ),
};

describe("admits", () => {
  const local = serveGate(7341);
  const pageAt = (origin: string): Gate => ({ ...local, origins: [origin] });

  test("accepts localhost Host and Origin for the listen port", () => {
    expect(admits(local, { host: "127.0.0.1:7341", origin: "http://127.0.0.1:7341" })).toBe(true);
    expect(admits(local, { host: "localhost:7341", origin: undefined })).toBe(true);
  });

  test("refuses a foreign Host or Origin", () => {
    expect(admits(local, { host: "example.com:7341", origin: undefined })).toBe(false);
    expect(admits(local, { host: "127.0.0.1:7341", origin: "http://example.com" })).toBe(false);
  });

  test("accepts a trusted page origin that is not the listen address", () => {
    const gate = pageAt("http://localhost:17341");
    expect(admits(gate, { host: "127.0.0.1:7341", origin: "http://localhost:17341" })).toBe(true);
    expect(admits(gate, { host: "127.0.0.1:7341", origin: "http://127.0.0.1:7341" })).toBe(false);
  });

  test("refuses another loopback port when only one page origin is trusted", () => {
    expect(
      admits(pageAt("http://127.0.0.1:17342"), {
        host: "127.0.0.1:7341",
        origin: "http://127.0.0.1:23315",
      }),
    ).toBe(false);
  });

  test("accepts a FOREMAN_UI_HOSTS name from its https page, with or without a port", () => {
    const gate = serveGate(7341, ["box.tailnet.ts.net", "box.tailnet.ts.net:8443"]);
    expect(admits(gate, { host: "box.tailnet.ts.net", origin: "https://box.tailnet.ts.net" })).toBe(
      true,
    );
    expect(
      admits(gate, { host: "box.tailnet.ts.net:8443", origin: "https://box.tailnet.ts.net:8443" }),
    ).toBe(true);
    expect(admits(gate, { host: "box.tailnet.ts.net", origin: undefined })).toBe(true);
  });

  test("refuses a rebound host from its own origin, and an extra name over http", () => {
    const gate = serveGate(7341, ["box.tailnet.ts.net"]);
    expect(admits(gate, { host: "evil.example", origin: "https://evil.example" })).toBe(false);
    expect(admits(gate, { host: "box.tailnet.ts.net", origin: "http://box.tailnet.ts.net" })).toBe(
      false,
    );
  });
});

describe("uiHosts", () => {
  const read = (value: string | undefined) =>
    Effect.runSync(
      Effect.gen(function* () {
        return yield* uiHosts;
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: value === undefined ? {} : { FOREMAN_UI_HOSTS: value } }),
          ),
        ),
      ),
    );

  test("is empty when unset, and splits a comma list with spaces and empties dropped", () => {
    expect(read(undefined)).toEqual([]);
    expect(read(" a.ts.net , ,b.ts.net:8443")).toEqual(["a.ts.net", "b.ts.net:8443"]);
  });
});

describe("UiContract handlers", () => {
  test("PipelineEdit through the contract and through foreman pipeline edit leave the same drafts file", async () => {
    writeFileSync(path, JSON.stringify({ pipelines: { amux: pinned }, composites: {} }));

    await runPipeline("edit", "amux", JSON.stringify(change));
    const fromCli = readFileSync(drafts, "utf8");
    rmSync(drafts, { force: true });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        yield* client.PipelineEdit({ project: "amux", change, flow: "across" });
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    const fromContract = readFileSync(drafts, "utf8");

    expect(JSON.parse(fromContract)).toEqual(JSON.parse(fromCli));
  });

  const graphOf = (statuses?: ReadonlyArray<TaskState>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        return yield* client.PipelineGraph({
          project: "graphp",
          statuses: statuses ?? GRAPH_STATUSES,
        });
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );

  test("PipelineGraph shows open and claimed work unless statuses ask for more", async () => {
    const unfinished = await graphOf();
    expect(unfinished.items.map((item) => item.id).toSorted()).toEqual(["ep-g", "ts-a", "ts-b"]);
    expect(unfinished.edges).toEqual([{ item: "ts-b", dependsOn: "ts-a" }]);

    const all = await graphOf(["open", "in_progress", "done"]);
    expect(all.items.map((item) => item.id).toSorted()).toEqual(["ep-g", "ts-a", "ts-b", "ts-d"]);
    expect(all.edges.toSorted((a, b) => a.dependsOn.localeCompare(b.dependsOn))).toEqual([
      { item: "ts-b", dependsOn: "ts-a" },
      { item: "ts-b", dependsOn: "ts-d" },
    ]);
    const second = all.items.find((item) => item.id === "ts-b");
    expect(second?.waitsFor).toEqual(["ts-a"]);
    expect(second?.column).toBe(1);
  });

  test("PolicyGrant and PolicyRevoke write the policy file the dispatcher reads", async () => {
    const policyFile = join(folder, "policy.json");
    const scopes = (text: string) =>
      (JSON.parse(text) as { grants: ReadonlyArray<{ scope: string }> }).grants.map(
        (one) => one.scope,
      );
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        const granted = yield* client.PolicyGrant({
          scope: "ep-g",
          steps: ["author"],
          remaining: Option.none(),
        });
        expect(granted.grants.map((one) => one.scope)).toEqual(["ep-g"]);
        expect(scopes(readFileSync(policyFile, "utf8"))).toEqual(["ep-g"]);
        const revoked = yield* client.PolicyRevoke({ scope: "ep-g" });
        expect(revoked.grants).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    expect(scopes(readFileSync(policyFile, "utf8"))).toEqual([]);
  });

  test("PolicyPause, PolicyResume and PolicySlots write the policy file", async () => {
    const policyFile = join(folder, "policy.json");
    const stored = () =>
      JSON.parse(readFileSync(policyFile, "utf8")) as {
        paused?: boolean;
        slots?: number;
        projects?: Record<string, { paused?: boolean }>;
      };
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        expect((yield* client.PolicyPause({ project: Option.none() })).paused).toBe(true);
        expect(stored().paused).toBe(true);
        yield* client.PolicyResume({ project: Option.none() });
        expect(stored().paused).toBe(false);
        yield* client.PolicyPause({ project: Option.some("graphp") });
        expect(stored().projects?.["graphp"]?.paused).toBe(true);
        yield* client.PolicyResume({ project: Option.some("graphp") });
        expect((yield* client.PolicySlots({ count: 3 })).slots).toBe(3);
        expect(stored().slots).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
  });

  test("TaskAction runs a row action through a one-shot dispatcher, and refuses a key no row has", async () => {
    const refusal = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        return yield* client
          .TaskAction({ id: "ts-nowhere", action: { _tag: "retry" } })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    expect(refusal).toMatchObject({ _tag: "Refused" });
    expect(refusal.message).toContain("no row has that key");
    const probe = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        yield* client.TaskAction({ id: "ts-q", action: { _tag: "complete", reason: "by hand" } });
        return yield* SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) => sql<{ status: string }>`SELECT status FROM items WHERE id = 'ts-q'`,
          ),
          Effect.provide(store.layer),
        );
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    expect(probe.map((row) => row.status)).toEqual(["done"]);
  });

  test("Readings stream sends the fixed reading", async () => {
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        return yield* client.Readings().pipe(Stream.take(1), Stream.runHead);
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    expect(Option.isSome(first)).toBe(true);
    if (Option.isSome(first)) {
      expect(first.value.version).toBeDefined();
      expect(first.value.dispatcher).toBeNull();
    }
  });
});

describe("UiContract over a WebSocket", () => {
  test("PipelineEdit and Readings answer the page's client through the real server", async () => {
    const port = 7342;
    writeFileSync(path, JSON.stringify({ pipelines: { amux: pinned }, composites: {} }));
    await runPipeline("edit", "amux", JSON.stringify(change));
    const fromCli = readFileSync(drafts, "utf8");
    rmSync(drafts, { force: true });

    const server = Effect.runFork(
      Layer.launch(
        uiServerOn(port, { page: false }).pipe(Layer.provide(Layer.mergeAll(handlers, services))),
      ),
    );
    try {
      await new Promise((ready) => setTimeout(ready, 300));
      const clientLayer = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(BunSocket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
        Layer.provide(RpcSerialization.layerJson),
      );
      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(UiContract);
          yield* client.PipelineEdit({ project: "amux", change, flow: "across" });
          return yield* client.Readings().pipe(Stream.take(1), Stream.runHead);
        }).pipe(Effect.scoped, Effect.provide(clientLayer), Effect.timeout("10 seconds")),
      );
      expect(JSON.parse(readFileSync(drafts, "utf8"))).toEqual(JSON.parse(fromCli));
      expect(Option.isSome(first)).toBe(true);
    } finally {
      await Effect.runPromise(Fiber.interrupt(server));
    }
  });

  test("stopping the server with a connected page completes and closes the socket", async () => {
    const port = 7343;
    const server = Effect.runFork(
      Layer.launch(uiServerOn(port).pipe(Layer.provide(Layer.mergeAll(handlers, services)))),
    );
    // A page that keeps Readings open — the hang Bun's graceful stop had.
    const page = Effect.runFork(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(UiContract);
        yield* client.Readings().pipe(Stream.runDrain);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(BunSocket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
            Layer.provide(RpcSerialization.layerJson),
          ),
        ),
      ),
    );
    try {
      await Effect.runPromise(Effect.sleep("500 millis"));
      const probe = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
      await new Promise<void>((resolve, reject) => {
        probe.addEventListener("open", () => resolve(), { once: true });
        probe.addEventListener("error", () => reject(new Error("probe failed to open")), {
          once: true,
        });
      });
      const closed = new Promise<number>((resolve) => {
        probe.addEventListener("close", () => resolve(probe.readyState), { once: true });
      });
      const finished = await Promise.race([
        Effect.runPromise(Fiber.interrupt(server)).then(() => "stopped" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3000)),
      ]);
      expect(finished).toBe("stopped");
      expect(
        await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 1000))]),
      ).toBe(WebSocket.CLOSED);
    } finally {
      await Effect.runPromise(Fiber.interrupt(page).pipe(Effect.ignore));
      await Effect.runPromise(Fiber.interrupt(server).pipe(Effect.ignore));
    }
  });
});

describe("page assets", () => {
  test("the page entry is found and built from a cwd outside the checkout", async () => {
    const before = process.cwd();
    process.chdir(tmpdir());
    try {
      expect(resolvePageEntrypoint()).toMatch(/foreman-ui\/src\/main\.tsx$/);
      const assets = await Effect.runPromise(buildPageAssets);
      expect(assets.has("/")).toBe(true);
    } finally {
      process.chdir(before);
    }
  });

  test("Bun.build page is served at / and /p/<project>", async () => {
    const port = 7343;
    const server = Effect.runFork(
      Layer.launch(
        uiServerOn(port, { page: true }).pipe(Layer.provide(Layer.mergeAll(handlers, services))),
      ),
    );
    try {
      const deadline = Date.now() + 20_000;
      let home: Response | undefined;
      while (Date.now() < deadline) {
        try {
          home = await fetch(`http://127.0.0.1:${port}/`, {
            headers: { host: `127.0.0.1:${port}` },
          });
          if (home.status === 200) break;
        } catch {
          // build still running
        }
        await new Promise((ready) => setTimeout(ready, 100));
      }
      expect(home?.status).toBe(200);
      const html = await home!.text();
      expect(html).toContain('id="root"');
      expect(html).toContain("main.js");

      const project = await fetch(`http://127.0.0.1:${port}/p/amux`, {
        headers: { host: `127.0.0.1:${port}` },
      });
      expect(project.status).toBe(200);
      expect(await project.text()).toContain('id="root"');
    } finally {
      await Effect.runPromise(Fiber.interrupt(server));
    }
  });
});

describe("Origin and Host checks", () => {
  test("an upgrade with Origin http://example.com and a request with a foreign Host each get 403", async () => {
    const port = 7341;
    const { handler, dispose } = HttpRouter.toWebHandler(
      uiRoutesLayer(serveGate(port)).pipe(
        Layer.provide(handlers),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );
    try {
      const foreignHost = await handler(
        new Request(`http://127.0.0.1:${port}/rpc`, {
          headers: { host: `example.com:${port}` },
        }),
      );
      expect(foreignHost.status).toBe(403);
      expect(await foreignHost.text()).toBe("");

      const foreignOrigin = await handler(
        new Request(`http://127.0.0.1:${port}/rpc`, {
          headers: {
            host: `127.0.0.1:${port}`,
            origin: "http://example.com",
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": Buffer.from("foreman-ui-test").toString("base64"),
            "sec-websocket-version": "13",
          },
        }),
      );
      expect(foreignOrigin.status).toBe(403);
      expect(await foreignOrigin.text()).toBe("");
    } finally {
      await dispose();
    }
  });

  test("with one trusted page origin, another loopback port gets 403 on a request and an upgrade", async () => {
    const port = 7344;
    const trusted = "http://127.0.0.1:17342";
    const { handler, dispose } = HttpRouter.toWebHandler(
      uiRoutesLayer({ ...serveGate(port), origins: [trusted] }).pipe(
        Layer.provide(handlers),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );
    const host = `127.0.0.1:${port}`;
    const plain = (origin: string) =>
      new Request(`http://${host}/rpc`, { headers: { host, origin } });
    const upgrade = (origin: string) =>
      new Request(`http://${host}/rpc`, {
        headers: {
          host,
          origin,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": Buffer.from("foreman-ui-test").toString("base64"),
          "sec-websocket-version": "13",
        },
      });
    const foreign = "http://127.0.0.1:23315";
    try {
      expect((await handler(upgrade(trusted))).status).not.toBe(403);
      expect((await handler(upgrade(foreign))).status).toBe(403);
      expect((await handler(plain(trusted))).status).not.toBe(403);
      expect((await handler(plain(foreign))).status).toBe(403);
    } finally {
      await dispose();
    }
  });
});

/**
 * Runs `stream` until its second value. The write runs after the first value
 * and a short wait, so the file watches are attached before the change lands.
 */
const secondValueAfter = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  write: Effect.Effect<unknown, unknown, never>,
) =>
  Effect.gen(function* () {
    const values = yield* Queue.make<A>();
    const fiber = yield* stream.pipe(
      Stream.runForEach((value) => Queue.offer(values, value)),
      Effect.forkScoped,
    );
    yield* Queue.take(values);
    yield* Effect.sleep("300 millis");
    yield* write;
    const second = yield* Queue.take(values).pipe(Effect.timeout("5 seconds"));
    yield* Fiber.interrupt(fiber);
    return second;
  });

describe("Pipeline and Queue streams", () => {
  test("Pipeline sends again when the pipelines file changes", async () => {
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        return yield* secondValueAfter(
          client.Pipeline({ project: "amux", flow: "across" }),
          Effect.sync(() =>
            writeFileSync(path, JSON.stringify({ pipelines: { amux: pinned }, composites: {} })),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    expect(second.drawn).toBe(true);
  });

  test("Pipeline sends again when a contract edit changes the drafts file", async () => {
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        return yield* secondValueAfter(
          client.Pipeline({ project: "amux", flow: "across" }),
          client.PipelineEdit({ project: "amux", change, flow: "across" }),
        );
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    expect(second.draft).not.toBeNull();
  });

  test("Pipeline sends again when a file in the instructions folder changes", async () => {
    const folderOfPrompts = join(resolve().configDirectory, "prompts");
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        return yield* secondValueAfter(
          client.Pipeline({ project: "amux", flow: "across" }),
          Effect.sync(() => {
            mkdirSync(folderOfPrompts, { recursive: true });
            writeFileSync(join(folderOfPrompts, "author.md"), "instructions");
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    expect(second.project).toBe("amux");
  });

  test("Queue sends again when a reading changes", async () => {
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(UiContract);
        const readings = yield* ReadingsRef;
        return yield* secondValueAfter(
          client.Queue({ project: "amux" }),
          SubscriptionRef.set(readings, publishedOf(EMPTY_FLEET, Option.none())),
        );
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    );
    expect(Array.isArray(second)).toBe(true);
  });
});
