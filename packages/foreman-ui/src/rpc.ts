/**
 * AtomRpc client for the UI contract: WebSocket to the UI server, with
 * ConnectionHooks that drive the disconnect banner and reconnect reload.
 */
import { BrowserSocket } from "@effect/platform-browser";
import { Effect, Layer, Schedule } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { Published } from "foreman/published-schema";
import { UiContract } from "foreman/ui-contract";
import * as Stream from "effect/Stream";
import { reloadPage } from "./sockets.ts";

/** Connection to the UI server as the page shows it. */
export type ConnectionState = "connecting" | "connected" | "disconnected";

/** Sticky connection state for the banner and reload-on-reconnect rule. */
export const connectionAtom: Atom.Writable<ConnectionState> = Atom.make<ConnectionState>(
  "connecting",
).pipe(Atom.keepAlive);

declare global {
  interface Window {
    /** When the page is served by vitest, the UI server listen port. */
    __FOREMAN_UI_PORT__?: number;
  }
}

/** WebSocket URL for the contract: same origin, or an injected UI server port. */
export const rpcWebSocketUrl = (): string => {
  const port = globalThis.window?.__FOREMAN_UI_PORT__;
  if (typeof port === "number") {
    return `ws://127.0.0.1:${port}/rpc`;
  }
  const { protocol, host } = globalThis.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/rpc`;
};

/**
 * AtomRpc over the UI contract. Retries each second after a socket error.
 * After a successful session drops, the next connect reloads the page so it
 * runs the code of the new serve.
 */
export class UiRpc extends AtomRpc.Service<UiRpc>()("foreman-ui/UiRpc", {
  group: UiContract,
  protocol: (get) => {
    const registry = get.registry;
    const hooks = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.sync(() => {
        if (registry.get(connectionAtom) === "disconnected") {
          reloadPage();
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
      // Resolve the URL when the Layer builds so browser tests can inject the
      // fixture port before the first subscribe.
      Layer.provide(
        Layer.unwrap(Effect.sync(() => BrowserSocket.layerWebSocket(rpcWebSocketUrl()))),
      ),
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
