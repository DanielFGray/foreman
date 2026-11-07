/**
 * The UI server Layer: HTTP on this machine only, the contract's handlers on a
 * WebSocket route, Origin and Host checks (`docs/web-ui.md`).
 *
 * Handlers call the pipeline and composite verb functions; they hold no logic
 * of their own. The page's static build lands with the page package; this Layer
 * is the contract transport and the local-only bind.
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
import { dirname, join } from "node:path";
import {
  compositeDiscard,
  compositeEdit,
  compositePrompt,
  compositeSave,
  compositeShow,
} from "./composite-command.ts";
import { queueOf } from "./host.ts";
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
import { PipelineError } from "./errors.ts";
import { draftsPath, pipelinesPath, resolve } from "./paths.ts";
import { publishedQueue } from "./published.ts";
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

/** Host values this server accepts for the given listen port. */
export const allowedHosts = (port: number): ReadonlySet<string> =>
  new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

/** Origin values this server accepts when Origin is present. */
export const allowedOrigins = (port: number): ReadonlySet<string> =>
  new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

/**
 * Whether a request's Host and Origin are allowed for this listen port.
 * Missing Origin is allowed (non-browser clients); a foreign Origin or Host is not.
 */
export const localRequest = (
  port: number,
  headers: { readonly host: string | undefined; readonly origin: string | undefined },
): boolean => {
  const host = headers.host;
  if (host === undefined || !allowedHosts(port).has(host)) return false;
  const origin = headers.origin;
  if (origin !== undefined && !allowedOrigins(port).has(origin)) return false;
  return true;
};

/** 403 with no body for a foreign Host or Origin. */
const refuse = HttpServerResponse.empty({ status: 403 });

/**
 * Global middleware: every request and WebSocket upgrade must name this
 * machine's listen address. Returns 403 with no body otherwise.
 */
export const localOnlyMiddleware = (port: number) =>
  HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return localRequest(port, {
          host: request.headers.host,
          origin: request.headers.origin,
        })
          ? yield* httpEffect
          : refuse;
      }),
    { global: true },
  );

/**
 * Failures no page can answer: a file the OS would not open, a store that
 * would not answer, a stored file that no longer decodes. They end the call as
 * a defect. The refusals a verb names stay in the contract as their tagged
 * errors, the ones the CLI prints.
 */
/** The tags of failures no page can answer (see infraAsDefects). */
const INFRA_TAGS: ReadonlyArray<string> = ["PlatformError", "SchemaError", "SqlError"];

const isInfra = <E>(error: E): error is Extract<E, { readonly _tag: string }> =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  INFRA_TAGS.includes(error._tag);

/**
 * Failures no page can answer: a file the OS would not open, a store that
 * would not answer, a stored file that no longer decodes. They end the call as
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
          Stream.mapEffect(() =>
            infraAsDefects(
              queueOf(Option.some(payload.project)).pipe(
                Effect.map(({ queue, epics }) => publishedQueue(queue, epics)),
              ),
            ),
          ),
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
 * Routes: the contract on a WebSocket at `/rpc`, and the Origin/Host gate.
 * Callers provide `uiHandlersLayer` (and its services) and this Layer provides
 * the HTTP router wiring.
 */
export const uiRoutesLayer = (port: number) =>
  Layer.mergeAll(
    RpcServer.layerHttp({ group: UiContract, path: UI_RPC_PATH }),
    // Global middleware is itself a Layer (route middleware would use `.layer`).
    localOnlyMiddleware(port),
  ).pipe(Layer.provide(RpcSerialization.layerJson));

/**
 * One Layer: listen on `127.0.0.1` at `FOREMAN_UI_PORT` (default 7341), serve
 * the contract over WebSocket, refuse foreign Host and Origin. Requires
 * `ReadingsRef`, handler services, and the services the verbs need.
 *
 * Page static files are not part of this Layer yet: the page package lands in
 * its own task, and serve will merge that build beside this transport.
 */
export const uiServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* uiPort;
    return uiServerOn(port);
  }),
);

/**
 * Builds the UI server Layer for an already-known port (tests pick a free one
 * so they do not collide with a live serve on 7341).
 */
export const uiServerOn = (port: number) =>
  HttpRouter.serve(uiRoutesLayer(port).pipe(Layer.provide(uiHandlersLayer)), {
    disableLogger: true,
  }).pipe(
    Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port })),
    Layer.provide(BunServices.layer),
  );
