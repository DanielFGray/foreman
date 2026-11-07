import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcTest } from "effect/rpc";
import { Command } from "effect/cli";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "./config.ts";
import { EMPTY_FLEET, Dispatcher } from "./dispatcher.ts";
import { Fleet, FleetError, type Worker } from "./fleet.ts";
import type { Ladder } from "./ladder.ts";
import { publishedOf } from "./published.ts";
import { pipelineCommand as pipelineCommandWith } from "./pipeline-command.ts";
import { Records } from "./records.ts";
import { Repository } from "./repository.ts";
import { scratchStore, seed } from "./scratch-store.ts";
import { STANDARD_PIPELINES } from "./pipeline.ts";
import { UiContract } from "./ui-contract.ts";
import { localRequest, ReadingsRef, uiHandlersLayer, uiRoutesLayer } from "./ui-server.ts";

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
const handlers = uiHandlersLayer.pipe(
  Layer.provide(fixedReadings),
  Layer.provide(
    Layer.mergeAll(Records.layer, testSettings, Repository.Default, fakeFleet).pipe(
      Layer.provideMerge(BunServices.layer),
      Layer.provideMerge(store.registry),
    ),
  ),
);

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

describe("Origin and Host checks", () => {
  test("an upgrade with Origin http://example.com and a request with a foreign Host each get 403", async () => {
    const port = 7341;
    const { handler, dispose } = HttpRouter.toWebHandler(
      uiRoutesLayer(port).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
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
});
