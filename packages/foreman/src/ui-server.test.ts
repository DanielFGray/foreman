import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices, BunSocket } from "@effect/platform-bun";
import { Effect, Fiber, Layer, Option, Queue, Stream, SubscriptionRef } from "effect";
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
import type { Ladder } from "./ladder.ts";
import { publishedOf } from "./published.ts";
import { pipelineCommand as pipelineCommandWith } from "./pipeline-command.ts";
import { Records } from "./records.ts";
import { Repository } from "./repository.ts";
import { scratchStore, seed } from "./scratch-store.ts";
import { STANDARD_PIPELINES } from "./pipeline.ts";
import { UiContract } from "./ui-contract.ts";
import { resolve } from "./paths.ts";
import {
  buildPageAssets,
  localRequest,
  ReadingsRef,
  resolvePageEntrypoint,
  serveOrigins,
  uiHandlersLayer,
  uiRoutesLayer,
  uiServerOn,
} from "./ui-server.ts";

const folder = mkdtempSync(join(tmpdir(), "foreman-ui-server-"));
const path = join(folder, "pipelines.json");
process.env["FOREMAN_PIPELINES"] = path;
process.env["XDG_CONFIG_HOME"] = folder;
const store = scratchStore();
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
    spaces: Effect.succeed([folder]),
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
    ladder: [
      {
        name: "cheap",
        harness: "test",
        level: 0,
        model: undefined,
        provider: undefined,
        enabled: true,
        author: true,
        unmetered: false,
      },
    ] satisfies Ladder,
    reviewers: [],
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
const services = Layer.mergeAll(Records.layer, testSettings, Repository.Default, fakeFleet).pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(store.registry),
);
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

describe("localRequest", () => {
  test("accepts localhost Host and Origin for the listen port", () => {
    expect(localRequest(7341, { host: "127.0.0.1:7341", origin: "http://127.0.0.1:7341" })).toBe(
      true,
    );
    expect(localRequest(7341, { host: "localhost:7341", origin: undefined })).toBe(true);
  });

  test("refuses a foreign Host or Origin", () => {
    expect(localRequest(7341, { host: "example.com:7341", origin: undefined })).toBe(false);
    expect(localRequest(7341, { host: "127.0.0.1:7341", origin: "http://example.com" })).toBe(
      false,
    );
  });

  test("accepts a trusted page origin that is not the listen address", () => {
    expect(
      localRequest(7341, { host: "127.0.0.1:7341", origin: "http://localhost:17341" }, [
        "http://localhost:17341",
      ]),
    ).toBe(true);
    expect(
      localRequest(7341, { host: "127.0.0.1:7341", origin: "http://127.0.0.1:7341" }, [
        "http://localhost:17341",
      ]),
    ).toBe(false);
  });

  test("refuses another loopback port when only one page origin is trusted", () => {
    expect(
      localRequest(7341, { host: "127.0.0.1:7341", origin: "http://127.0.0.1:23315" }, [
        "http://127.0.0.1:17342",
      ]),
    ).toBe(false);
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
      const assets = await Effect.runPromise(buildPageAssets());
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
      uiRoutesLayer(port, serveOrigins(port)).pipe(
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
      uiRoutesLayer(port, [trusted]).pipe(
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
