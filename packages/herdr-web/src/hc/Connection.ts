// One connection to herdr-core (hc): JSON-RPC 2.0, one message per line.
// Replies are matched to calls by id; notifications (only a subscribed
// connection gets them) arrive on a Stream decoded with the caller's Schema.
//
// Effect's RpcClient is not used: its socket protocol pings every few seconds
// and drops a connection that sends no frame back, and hc never answers a ping.
import { BunSocket } from "@effect/platform-bun"
import { Deferred, Effect, Match, MutableHashMap, Option, Queue, Ref, Schema as S, Stream } from "effect"
import { Ndjson } from "effect/encoding"
import { Socket } from "effect/socket"
import { wireTag } from "../shared/Wire.ts"

/** hc refused a call; `kind` is its stable error kind (`not_found`, `blocked`, ...). */
export class HcError extends S.TaggedError<HcError, { readonly brand: unique symbol }>()("HcError", {
  method: S.String,
  kind: S.String,
  message: S.String,
}) {}

/** The connection ended or never opened: hc stopped, restarted or is not running. */
export class HcLost extends S.TaggedError<HcLost, { readonly brand: unique symbol }>()("HcLost", {
  cause: S.Defect(),
}) {}

/** hc sent something this client cannot read, or speaks another protocol generation. */
export class HcProtocolError extends S.TaggedError<HcProtocolError, { readonly brand: unique symbol }>()("HcProtocolError", {
  cause: S.Defect(),
}) {}

export type HcFailure = HcError | HcLost | HcProtocolError

/** An hc method: its name with the Schemas of its params and its result. */
export interface Method<P, A, AI> {
  readonly name: string
  readonly request: S.Codec<Request<P>, string>
  readonly result: S.Codec<A, AI>
}

interface Request<P> {
  readonly jsonrpc: "2.0"
  readonly id: string
  readonly method: string
  readonly params: P
}

export const method = <P, PI, A, AI>(
  name: string,
  params: S.Codec<P, PI>,
  result: S.Codec<A, AI>,
): Method<P, A, AI> => ({
  name,
  request: S.fromJsonString(
    S.Struct({ jsonrpc: S.Literal("2.0"), id: S.String, method: S.String, params }),
  ),
  result,
})

export interface Connection<N> {
  readonly call: <P, A, AI>(method: Method<P, A, AI>, params: P) => Effect.Effect<A, HcFailure>
  /** Notifications in arrival order; fails with HcLost when the connection ends. */
  readonly notifications: Stream.Stream<N, HcLost>
}

/**
 * Opens a connection in the current scope and says `hello` (protocol
 * generation 1). Closing the scope closes the socket. When the socket ends,
 * every call in flight and the notification stream fail with HcLost.
 */
export const connect = Effect.fnUntraced(function* <N, NI>(path: string, notification: S.Codec<N, NI>) {
  const socket = yield* BunSocket.makeNet({ path })
  const writer = yield* socket.writer
  const nextId = yield* Ref.make(0)
  const notes = yield* Queue.unbounded<N, HcLost>()
  // Each call waiting for its reply. The entry decodes the reply into that
  // call's own result type, so nothing undecoded outlives the match.
  const pending = MutableHashMap.empty<string, (reply: Reply | Lost) => Effect.Effect<void>>()

  const lose = (cause: unknown) =>
    Effect.gen(function* () {
      const error = new HcLost({ cause })
      const waiting = Array.from(MutableHashMap.values(pending))
      MutableHashMap.clear(pending)
      yield* Effect.forEach(waiting, (complete) => complete({ _tag: "Lost", error }), { discard: true })
      yield* Queue.fail(notes, error)
    })

  const dispatch = (message: Reply | N) =>
    isReply(message)
      ? Effect.suspend(() => {
          const complete = MutableHashMap.get(pending, message.id)
          MutableHashMap.remove(pending, message.id)
          return Option.match(complete, { onNone: () => Effect.void, onSome: (f) => f(message) })
        })
      : Queue.offer(notes, message).pipe(Effect.asVoid)

  yield* Socket.toStream(socket).pipe(
    Stream.pipeThroughChannel(Ndjson.decodeSchema(S.Union([Reply, notification]))()),
    Stream.runForEach(dispatch),
    Effect.matchCauseEffect({
      onSuccess: () => lose("hc closed the connection"),
      onFailure: (cause) => lose(cause),
    }),
    Effect.forkScoped,
  )

  const call = <P, A, AI>(m: Method<P, A, AI>, params: P): Effect.Effect<A, HcFailure> =>
    Effect.gen(function* () {
      const id = String(yield* Ref.getAndUpdate(nextId, (n) => n + 1))
      const done = yield* Deferred.make<A, HcFailure>()
      MutableHashMap.set(pending, id, (reply) =>
        Deferred.completeWith(
          done,
          Match.valueTags(reply, { Lost: ({ error }) => Effect.fail(error), Failure: (failure) => settle(m, failure), Success: (success) => settle(m, success) }),
        ).pipe(Effect.asVoid),
      )
      const line = yield* S.encodeEffect(m.request)({ jsonrpc: "2.0", id, method: m.name, params }).pipe(
        Effect.mapError((cause) => new HcProtocolError({ cause })),
      )
      yield* writer.write(`${line}\n`).pipe(Effect.mapError((cause) => new HcLost({ cause })))
      return yield* Deferred.await(done)
    }).pipe(Effect.withSpan(`hc.${m.name}`))

  yield* call(hello, { generation: 1 })
  return { call, notifications: Stream.fromQueue(notes) } satisfies Connection<N>
})

/** A reply as the call's result, or the error hc gave. */
export const settle = <P, A, AI>(m: Method<P, A, AI>, reply: Reply): Effect.Effect<A, HcError | HcProtocolError> =>
  Match.valueTags(reply, {
    Failure: ({ error }) => Effect.fail(new HcError({ method: m.name, kind: error.data.kind, message: error.message })),
    Success: ({ result }) =>
      S.decodeUnknownEffect(m.result)(result).pipe(Effect.mapError((cause) => new HcProtocolError({ cause }))),
  })

const hello = method(
  "hello",
  S.Struct({ generation: S.Literal(1) }),
  S.Struct({ generation: S.Literal(1) }),
)

// `result` stays undecoded here: its Schema belongs to the call that the id
// names, and that call decodes it as soon as the reply is matched.
const Success = S.Struct({ _tag: wireTag("Success"), id: S.String, result: S.Unknown })
const Failure = S.Struct({
  _tag: wireTag("Failure"),
  id: S.String,
  error: S.Struct({ message: S.String, data: S.Struct({ kind: S.String }) }),
})

/** A reply to a call, with its result not yet decoded. */
export const Reply = S.Union([Success, Failure])
export type Reply = typeof Reply.Type
interface Lost {
  readonly _tag: "Lost"
  readonly error: HcLost
}

const isReply = S.is(S.toType(Reply))
