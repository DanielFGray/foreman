/**
 * AtomRpc client for the UI contract: WebSocket to the UI server, with
 * ConnectionHooks that drive the disconnect banner and reconnect reload.
 */
import { BrowserSocket } from "@effect/platform-browser";
import { Effect, Layer, Schedule, Schema as S } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { Flow } from "foreman/pipeline-view";
import type { Published } from "foreman/published-schema";
import { UiContract } from "foreman/ui-contract";
import { TaskState } from "tasks/item";
import * as Stream from "effect/Stream";

/** Connection to the UI server as the page shows it. */
export type ConnectionState = "connecting" | "connected" | "disconnected";

/** Sticky connection state for the banner and reload-on-reconnect rule. */
export const connectionAtom: Atom.Writable<ConnectionState> = Atom.make<ConnectionState>(
  "connecting",
).pipe(Atom.keepAlive);

/** Where the page connects, and what it does when a reconnect succeeds. */
export interface PageInputs {
  readonly rpcUrl: string;
  readonly reload: () => void;
}

/**
 * The page's inputs. The default is the page's own origin and a reload of the
 * page. A test replaces it through the registry's `initialValues`, so no
 * production code reads a test-only global.
 */
export const pageInputsAtom: Atom.Writable<PageInputs> = Atom.make<PageInputs>({
  rpcUrl: sameOriginRpcUrl(),
  reload: () => globalThis.location.reload(),
});

/** The contract's WebSocket path on the page's own host. */
function sameOriginRpcUrl(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/rpc`;
}

/**
 * AtomRpc over the UI contract. Retries each second after a socket error.
 * After a successful session drops, the next connect reloads the page so it
 * runs the code of the new serve.
 */
export class UiRpc extends AtomRpc.Service<UiRpc>()("foreman-ui/UiRpc", {
  group: UiContract,
  protocol: (get) => {
    const registry = get.registry;
    const inputs = get(pageInputsAtom);
    const hooks = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.sync(() => {
        if (registry.get(connectionAtom) === "disconnected") {
          inputs.reload();
          return;
        }
        registry.set(connectionAtom, "connected");
      }),
      onDisconnect: Effect.sync(() => {
        if (registry.get(connectionAtom) === "connected") {
          registry.set(connectionAtom, "disconnected");
        }
      }),
    });
    return RpcClient.layerProtocolSocket({
      retryTransientErrors: true,
      retryPolicy: Schedule.spaced("1 second"),
    }).pipe(
      Layer.provide(hooks),
      Layer.provide(BrowserSocket.layerWebSocket(inputs.rpcUrl)),
      Layer.provide(RpcSerialization.layerJson),
    );
  },
}) {}

/**
 * Latest Published reading from the Readings stream. The atom keeps the last
 * frame as each value arrives.
 */
export const readingsAtom: Atom.Atom<AsyncResult.AsyncResult<Published, unknown>> =
  UiRpc.runtime.atom(
    Stream.unwrap(UiRpc.use((client) => Effect.succeed(client("Readings", void 0 as never)))),
  );

/**
 * Latest pipeline view for a project, laid out in `flow`, from the Pipeline
 * stream. The atom keeps the last frame as each value arrives.
 */
export const pipelineAtom = Atom.family((project: string) =>
  Atom.family((flow: Flow) =>
    UiRpc.runtime.atom(
      Stream.unwrap(UiRpc.use((client) => Effect.succeed(client("Pipeline", { project, flow })))),
    ),
  ),
);

/** The reactivity key every task-graph read and policy write shares. */
export const GRAPH_KEYS = ["graph"] as const;

/**
 * A project's task graph in the statuses that `statusKey` lists, joined by
 * commas. PipelineGraph answers once; a PolicyGrant or PolicyRevoke sent with
 * `GRAPH_KEYS` asks it again. The key is a string so one atom serves each
 * filter.
 */
export const graphAtom = Atom.family((project: string) =>
  Atom.family((statusKey: string) =>
    UiRpc.query(
      "PipelineGraph",
      { project, statuses: statusKey.split(",").filter(S.is(TaskState)) },
      { reactivityKeys: GRAPH_KEYS },
    ),
  ),
);
