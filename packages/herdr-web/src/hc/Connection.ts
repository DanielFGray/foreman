// One connection to herdr-core (hc): JSON-RPC 2.0, one message per line.
// Replies are matched to calls by id; notifications (only a subscribed
// connection gets them) arrive on a Stream decoded with the caller's Schema.
//
// Effect's RpcClient is not used: its socket protocol pings every few seconds
// and drops a connection that sends no frame back, and hc never answers a ping.
import { BunSocket } from "@effect/platform-bun"
import { Deferred, Effect, Match, MutableHashMap, Option, Queue, Ref, Schema, Stream } from "effect"
import { Ndjson } from "effect/encoding"
import { Socket } from "effect/socket"
import { wireTag } from "../shared/Wire.ts"

/** hc refused a call; `kind` is its stable error kind (`not_found`, `blocked`, ...). */
export class HcError extends Schema.TaggedError<HcError, { readonly brand: unique symbol }>()("HcError", {
  method: Schema.String,
  kind: Schema.String,
  message: Schema.String,
}) {}

/** The connection ended or never opened: hc stopped, restarted or is not running. */
export class HcLost extends Schema.TaggedError<HcLost, { readonly brand: unique symbol }>()("HcLost", {
  cause: Schema.Defect(),
}) {}

/** hc sent something this client cannot read, or speaks another protocol generation. */
export class HcProtocolError extends Schema.TaggedError<HcProtocolError, { readonly brand: unique symbol }>()("HcProtocolError", {
  cause: Schema.Defect(),
}) {}

export type HcFailure = HcError | HcLost | HcProtocolError

/** An hc method: its name with the Schemas of its params and its result. */
export interface Method<P, A, AI> {
  readonly name: string
  readonly request: Schema.Codec<Request<P>, string>
  readonly result: Schema.Codec<A, AI>
}

interface Request<P> {
  readonly jsonrpc: "2.0"
  readonly id: string
  readonly method: string
  readonly params: P
}

export const method = <P, PI, A, AI>(
  name: string,
  params: Schema.Codec<P, PI>,
  result: Schema.Codec<A, AI>,
): Method<P, A, AI> => ({
  name,
  request: Schema.fromJsonString(
    Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Schema.String, method: Schema.String, params }),
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
export const connect = Effect.fnUntraced(function* <N, NI>(path: string, notification: Schema.Codec<N, NI>) {
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
    Stream.pipeThroughChannel(Ndjson.decodeSchema(Schema.Union([Success, Failure, notification]))()),
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
          Match.valueTags(reply, {
            Lost: ({ error }) => Effect.fail(error),
            Failure: ({ error }) =>
              Effect.fail(new HcError({ method: m.name, kind: error.data.kind, message: error.message })),
            Success: ({ result }) =>
              Schema.decodeUnknownEffect(m.result)(result).pipe(
                Effect.mapError((cause) => new HcProtocolError({ cause })),
              ),
          }),
        ).pipe(Effect.asVoid),
      )
      const line = yield* Schema.encodeEffect(m.request)({ jsonrpc: "2.0", id, method: m.name, params }).pipe(
        Effect.mapError((cause) => new HcProtocolError({ cause })),
      )
      yield* writer.write(`${line}\n`).pipe(Effect.mapError((cause) => new HcLost({ cause })))
      return yield* Deferred.await(done)
    }).pipe(Effect.withSpan(`hc.${m.name}`))

  yield* call(hello, { generation: 1 })
  return { call, notifications: Stream.fromQueue(notes) } satisfies Connection<N>
})

const hello = method(
  "hello",
  Schema.Struct({ generation: Schema.Literal(1) }),
  Schema.Struct({ generation: Schema.Literal(1) }),
)

// `result` stays undecoded here: its Schema belongs to the call that the id
// names, and that call decodes it as soon as the reply is matched.
const Success = Schema.Struct({ _tag: wireTag("Success"), id: Schema.String, result: Schema.Unknown })
const Failure = Schema.Struct({
  _tag: wireTag("Failure"),
  id: Schema.String,
  error: Schema.Struct({ message: Schema.String, data: Schema.Struct({ kind: Schema.String }) }),
})

type Reply = typeof Success.Type | typeof Failure.Type
interface Lost {
  readonly _tag: "Lost"
  readonly error: HcLost
}

const isReply = Schema.is(Schema.Union([Schema.toType(Success), Schema.toType(Failure)]))
