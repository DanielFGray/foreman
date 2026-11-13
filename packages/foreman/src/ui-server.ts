/**
 * The UI server Layer: HTTP on 127.0.0.1, the contract's handlers on a
 * WebSocket route, Origin and Host checks, and the page's Bun.build outputs
 * served from memory (`docs/web-ui.md`).
 *
 * Handlers call the pipeline and composite verb functions; they hold no logic
 * of their own. The gate is an input of this Layer: serve passes its own
 * address and the names in `FOREMAN_UI_HOSTS`; page tests pass vitest's
 * browser-page origin.
 */
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  compositeDiscard,
  compositeEdit,
  compositePrompt,
  compositeSave,
  compositeShow,
} from "./composite-command.ts";
import { queueRowsOf } from "./host.ts";
import {
  pipelineDiscard,
  pipelineEdit,
  pipelineGraph,
  pipelineInstructions,
  pipelinePrompt,
  pipelineSave,
  pipelineShow,
  pipelineSimulate,
  pipelineTrace,
} from "./pipeline-command.ts";
import { PageBuildError } from "./errors.ts";
import { draftsPath, pipelinesPath, resolve } from "./paths.ts";
import { type Published } from "./published-schema.ts";
import { UiContract } from "./ui-contract.ts";

/** Default listen port when `FOREMAN_UI_PORT` is unset. */
export const DEFAULT_UI_PORT = 7341;

/** The WebSocket path the page opens for the contract. */
export const UI_RPC_PATH = "/rpc" as const;

/**
 * Process-lifetime readings the Readings and Queue streams read. Serve builds
 * one and provides it beside this Layer; tests fill it with fixed values.
 */
export class ReadingsRef extends Context.Service<
  ReadingsRef,
  SubscriptionRef.SubscriptionRef<Published>
>()("foreman/ReadingsRef") {}

/** `FOREMAN_UI_PORT` through Config, default 7341. */
export const uiPort = Config.Int("FOREMAN_UI_PORT").pipe(Config.withDefault(DEFAULT_UI_PORT));

/**
 * Extra names the page is reached by, such as a Tailscale name, from
 * `FOREMAN_UI_HOSTS`: comma separated, each exactly as the browser sends it in
 * `Host` (`box.tailnet.ts.net`, or `box.tailnet.ts.net:8443` off port 443).
 */
export const uiHosts = Config.String("FOREMAN_UI_HOSTS").pipe(
  Config.map((list) =>
    list
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  ),
  Config.withDefault<ReadonlyArray<string>>([]),
);

/**
 * What the server admits: the `Host` values a request may name, and the
 * `Origin` values a browser page may send.
 */
export type Gate = {
  readonly hosts: ReadonlySet<string>;
  readonly origins: ReadonlyArray<string>;
};

/**
 * The gate serve uses: its listen address under both loopback names, over
 * http, and each extra name over https. An extra name is reached through a
 * proxy such as `tailscale serve`, which serves only https.
 */
export const serveGate = (port: number, names: ReadonlyArray<string> = []): Gate => ({
  hosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...names]),
  origins: [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...names.map((name) => `https://${name}`),
  ],
});

/**
 * Whether the gate admits a request. Missing Origin is admitted (navigation
 * and non-browser clients); the Host check covers them.
 */
export const admits = (
  gate: Gate,
  headers: { readonly host: string | undefined; readonly origin: string | undefined },
): boolean =>
  headers.host !== undefined &&
  gate.hosts.has(headers.host) &&
  (headers.origin === undefined || gate.origins.includes(headers.origin));

/** 403 with no body for a foreign Host or Origin. */
const refuse = HttpServerResponse.empty({ status: 403 });

/**
 * Global middleware: every request and WebSocket upgrade the gate does not
 * admit gets 403 with no body.
 */
export const gateMiddleware = (gate: Gate) =>
  HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return admits(gate, { host: request.headers.host, origin: request.headers.origin })
          ? yield* httpEffect
          : refuse;
      }),
    { global: true },
  );

/** The tags of failures no page can answer (see infraAsDefects). */
const INFRA_TAGS: ReadonlyArray<string> = ["PlatformError", "SchemaError", "SqlError"];

const isInfra = <E>(
  error: E,
): error is Extract<E, { readonly _tag: "PlatformError" | "SchemaError" | "SqlError" }> =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  INFRA_TAGS.includes(error._tag);

/**
 * Failures no page can answer: a file the OS would not open, a store that
 * would not answer, a stored file that fails to decode. They end the call as
 * a defect. The refusals a verb names stay in the contract as their tagged
 * errors, the ones the CLI prints.
 */
const infraAsDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catchIf(isInfra<E>, (error) => Effect.die(error)));

/**
 * Handlers for the contract: streams and verbs. Each verb handler only calls
 * the matching exported Effect function.
 */
export const uiHandlersLayer = UiContract.toLayer(
  Effect.gen(function* () {
    const readings = yield* ReadingsRef;
    return UiContract.of({
      Readings: () => SubscriptionRef.changes(readings),
      Pipeline: (payload) => pipelineChanges(payload.project, payload.flow),
      Queue: (payload) =>
        SubscriptionRef.changes(readings).pipe(
          Stream.mapEffect(() => infraAsDefects(queueRowsOf(Option.some(payload.project)))),
        ),
      PipelineShow: (payload) => infraAsDefects(pipelineShow(payload)),
      PipelineEdit: (payload) => infraAsDefects(pipelineEdit(payload)),
      PipelineSave: (payload) => infraAsDefects(pipelineSave(payload)),
      PipelineDiscard: (payload) => infraAsDefects(pipelineDiscard(payload)),
      PipelineInstructions: (payload) =>
        infraAsDefects(pipelineInstructions({ name: payload.name, text: payload.text })),
      PipelinePrompt: (payload) => infraAsDefects(pipelinePrompt(payload)),
      PipelineTrace: (payload) => infraAsDefects(pipelineTrace(payload)),
      PipelineSimulate: (payload) => infraAsDefects(pipelineSimulate(payload)),
      PipelineGraph: (payload) => infraAsDefects(pipelineGraph(payload)),
      CompositeShow: (payload) => infraAsDefects(compositeShow(payload)),
      CompositeEdit: (payload) => infraAsDefects(compositeEdit(payload)),
      CompositeSave: (payload) => infraAsDefects(compositeSave(payload)),
      CompositeDiscard: (payload) => infraAsDefects(compositeDiscard(payload)),
      CompositePrompt: (payload) => infraAsDefects(compositePrompt(payload)),
    });
  }),
);

/**
 * The Pipeline stream: one show at once, then again when the pipelines file,
 * drafts file or instructions folder changes. The watches are attached before
 * the first show is sent, so a write made while the show runs is still seen.
 */
const pipelineChanges = (project: string, flow: "across" | "down") =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const show = infraAsDefects(pipelineShow({ project, flow }));
      // Pipelines file, drafts file and prompts folder: create each directory
      // so the watch can attach, then merge their events into one pulse stream.
      const dirs = [
        ...new Set([
          dirname(pipelinesPath()),
          dirname(draftsPath()),
          join(resolve().configDirectory, "prompts"),
        ]),
      ];
      for (const dir of dirs) {
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
      }
      const changes = Stream.mergeAll(
        dirs.map((dir) => fs.watch(dir).pipe(Stream.orDie)),
        { concurrency: "unbounded" },
      ).pipe(Stream.mapEffect(() => show));
      return Stream.merge(Stream.fromEffect(show), changes);
    }),
  );

/**
 * Options for {@link uiServerOn}: the gate, and whether to Bun.build and serve
 * the page.
 */
export type UiServerOptions = {
  /** Default: {@link serveGate} for the port, with no extra names. */
  readonly gate?: Gate;
  /** When false, skip the page build (contract-only tests). Default true. */
  readonly page?: boolean;
};

/** Built page files keyed by URL path (`/`, `/main.js`, …). */
export type PageAssets = ReadonlyMap<
  string,
  { readonly body: Uint8Array; readonly contentType: string }
>;

/**
 * Page bundle entry, located from this module's own file so the result does
 * not depend on the caller's cwd. The page tests load this module through
 * vitest, whose cwd is the test package, not the foreman checkout.
 */
export const resolvePageEntrypoint = (): string =>
  fileURLToPath(new URL("../../foreman-ui/src/main.tsx", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

const contentTypeOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? CONTENT_TYPES[path.slice(dot)] : undefined) ?? "application/octet-stream";
};

/**
 * Runs `Bun.build` on the page entry for the browser target. A failed build
 * fails this Effect so the UI server Layer stops; the dispatcher is separate.
 */
export const buildPageAssets: Effect.Effect<PageAssets, PageBuildError> = Effect.tryPromise({
  try: async () => {
    const result = await Bun.build({
      entrypoints: [resolvePageEntrypoint()],
      target: "browser",
      format: "esm",
      minify: false,
      sourcemap: "none",
    });
    if (!result.success) {
      const messages = result.logs.map((log) => log.message ?? String(log)).join("\n");
      throw new PageBuildError({ detail: `foreman-ui Bun.build failed:\n${messages}` });
    }
    const assets = new Map<string, { readonly body: Uint8Array; readonly contentType: string }>();
    let mainJs = "/main.js";
    let mainCss: string | undefined;
    for (const output of result.outputs) {
      const bytes = new Uint8Array(await output.arrayBuffer());
      const base = output.path.split(/[/\\]/).at(-1) ?? "main.js";
      const urlPath = `/${base}`;
      assets.set(urlPath, { body: bytes, contentType: contentTypeOf(urlPath) });
      if (base.endsWith(".js") && !base.endsWith(".js.map")) mainJs = urlPath;
      if (base.endsWith(".css")) mainCss = urlPath;
    }
    const cssLink = mainCss === undefined ? "" : `<link rel="stylesheet" href="${mainCss}"/>`;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Foreman</title>
${cssLink}
</head>
<body>
<div id="root"></div>
<script type="module" src="${mainJs}"></script>
</body>
</html>
`;
    const htmlBytes = new TextEncoder().encode(html);
    assets.set("/", { body: htmlBytes, contentType: "text/html; charset=utf-8" });
    assets.set("/index.html", { body: htmlBytes, contentType: "text/html; charset=utf-8" });
    return assets;
  },
  catch: (cause) =>
    cause instanceof PageBuildError
      ? cause
      : new PageBuildError({ detail: cause instanceof Error ? cause.message : String(cause) }),
});

/** Serves built page assets; unknown paths fall through to the SPA shell at `/`. */
export const pageRoutesLayer = (assets: PageAssets) =>
  HttpRouter.add("GET", "*", (request) => {
    // Bun's request.url is the path (e.g. `/main.js`), not an absolute URL.
    const path = request.url.split("?")[0] ?? request.url;
    const asset =
      assets.get(path) ?? (path.startsWith("/p/") || path === "/" ? assets.get("/") : undefined);
    if (asset === undefined) {
      return Effect.succeed(HttpServerResponse.empty({ status: 404 }));
    }
    return Effect.succeed(
      HttpServerResponse.uint8Array(asset.body, {
        contentType: asset.contentType,
        headers: { "cache-control": "no-store" },
      }),
    );
  });

/**
 * Routes: the contract on a WebSocket at `/rpc`, and the Origin/Host gate.
 * Callers provide `uiHandlersLayer` (and its services) and this Layer provides
 * the HTTP router wiring.
 */
export const uiRoutesLayer = (gate: Gate) =>
  Layer.mergeAll(
    RpcServer.layerHttp({ group: UiContract, path: UI_RPC_PATH, protocol: "websocket" }),
    // Global middleware is itself a Layer (route middleware would use `.layer`).
    gateMiddleware(gate),
  ).pipe(Layer.provide(RpcSerialization.layerJson));

/**
 * One Layer: listen on `127.0.0.1` at `FOREMAN_UI_PORT` (default 7341), serve
 * the contract over WebSocket, refuse a Host or Origin outside the gate
 * (`FOREMAN_UI_HOSTS` adds names), and serve the page's Bun.build outputs.
 * Requires `ReadingsRef`, handler services, and the services the verbs need.
 * `foreman serve` provides this beside supervise.
 */
export const uiServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* uiPort;
    return uiServerOn(port, { gate: serveGate(port, yield* uiHosts) });
  }),
);

/**
 * Builds the UI server Layer for an already-known port (tests pick a free one
 * so they do not collide with a live serve on 7341).
 *
 * Stop uses `@effect/platform-bun`'s patched `server.stop(true)` so an open
 * page WebSocket does not hold the Layer open (see patches/ and web-ui.md).
 * Page tests pass a gate whose origin is vitest's page.
 */
export const uiServerOn = (port: number, options?: UiServerOptions) => {
  const gate = options?.gate ?? serveGate(port);
  const withPage = options?.page !== false;
  return Layer.unwrap(
    Effect.gen(function* () {
      const routes = withPage
        ? Layer.mergeAll(uiRoutesLayer(gate), pageRoutesLayer(yield* buildPageAssets))
        : uiRoutesLayer(gate);
      return HttpRouter.serve(routes.pipe(Layer.provide(uiHandlersLayer)), {
        disableLogger: true,
      }).pipe(
        Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port })),
        Layer.provide(BunServices.layer),
      );
    }),
  );
};
