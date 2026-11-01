// A live terminal from hc: its output as it is written, and a way to type into
// it and set its size. Each stream has a framed connection of its own, which
// carries the attach call on channel 0 and the terminal's bytes on the channel
// hc gives back.
import { BunSocket } from "@effect/platform-bun"
import { Cause, Deferred, Effect, Match, Queue, Schema as S, Stream } from "effect"
import { Socket } from "effect/socket"
import { type HcFailure, HcLost, HcProtocolError, type Method, method, Reply, settle } from "./Connection.ts"
import { creditPayload, encodeFrame, type Frame, FrameKind, type Incoming, readConnection, resizePayload, startReading } from "./Frame.ts"

export type AttachRequest = Readonly<{ terminal: string; cols: number; rows: number }>

/** The terminal's size in cells, as hc reports it when a stream opens. */
export type Size = Readonly<{ cols: number; rows: number }>

export interface Attached {
  /** The terminal's size when the stream opened. */
  readonly size: Size
  /** The terminal's screen first, then everything it writes; ends when hc closes the stream. */
  readonly output: Stream.Stream<Uint8Array, HcFailure>
  readonly input: (bytes: Uint8Array) => Effect.Effect<void, HcLost>
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, HcLost>
}

/**
 * Attaches to a terminal in the current scope; closing the scope closes the
 * stream, and hc gives the terminal back its earlier size. With `resumed`, the
 * terminal takes the size of the viewer that typed last: a viewer that only
 * watches does not resize it for one in use. (Probed on hc 0.1.14: a lone
 * viewer's size applies at once.)
 */
export const attach = (path: string, request: AttachRequest) => open(path, viewerParams(request))

/**
 * Watches a terminal in the current scope without typing into it or setting
 * its size, so the program keeps the size its own viewers gave it.
 */
export const observe = (path: string, terminal: string, history: number) => open(path, { terminal, cols: 0, rows: 0, observe: true, history })

const open = Effect.fnUntraced(function* (path: string, params: AttachParams) {
  const socket = yield* BunSocket.makeNet({ path })
  const writer = yield* socket.writer
  const write = (bytes: Uint8Array | string) => writer.write(bytes).pipe(Effect.mapError((cause) => new HcLost({ cause })))
  const send = (frame: Frame) => write(encodeFrame(frame))

  const helloReply = yield* Deferred.make<string, HcLost>()
  const attachReply = yield* Deferred.make<string, HcLost>()
  const output = yield* Queue.unbounded<Uint8Array, HcLost | Cause.Done>()

  const lose = (cause: unknown) =>
    Effect.gen(function* () {
      const error = new HcLost({ cause })
      yield* Deferred.fail(helloReply, error)
      yield* Deferred.fail(attachReply, error)
      yield* Queue.fail(output, error)
    })

  // Only this stream uses the connection: a frame on channel 0 is the reply
  // to the attach call, and any other channel is the stream's own.
  const dispatch = (incoming: Incoming) =>
    Match.valueTags(incoming, {
      Line: ({ line }) => Deferred.succeed(helloReply, line),
      Frame: ({ frame }) =>
        frame.channel === 0
          ? Deferred.succeed(attachReply, new TextDecoder().decode(frame.payload))
          : frame.kind === FrameKind.Data
            ? Queue.offer(output, frame.payload)
            : frame.kind === FrameKind.Close
              ? Queue.end(output)
              : // hc's own control frames (focus, facts) say nothing a web viewer uses.
                Effect.void,
    })

  yield* Socket.toStream(socket).pipe(
    Stream.mapAccum(() => startReading, readConnection),
    Stream.runForEach(dispatch),
    Effect.matchCauseEffect({
      onSuccess: () => lose("hc closed the connection"),
      onFailure: (cause) => lose(cause),
    }),
    Effect.forkScoped,
  )

  yield* write(`${yield* encodeRequest(framedHello, "0", { generation: 1, framed: true })}\n`)
  yield* Deferred.await(helloReply).pipe(Effect.flatMap(decodeReply), Effect.flatMap((reply) => settle(framedHello, reply)))

  yield* send({ channel: 0, kind: FrameKind.Data, payload: new TextEncoder().encode(yield* encodeRequest(attachMethod, "1", params)) })
  const { channel, terminal: size } = yield* Deferred.await(attachReply).pipe(
    Effect.flatMap(decodeReply),
    Effect.flatMap((reply) => settle(attachMethod, reply)),
  )
  // The connection may already be gone when the scope closes; then there is
  // no stream left to close.
  yield* Effect.addFinalizer(() => send({ channel, kind: FrameKind.Close, payload: new Uint8Array() }).pipe(Effect.ignore))

  return {
    size,
    // Credit goes back as the bridge passes output on, so a page that falls
    // behind slows the terminal's stream instead of filling the bridge.
    output: Stream.fromQueue(output).pipe(
      Stream.tap((bytes) => send({ channel, kind: FrameKind.Credit, payload: creditPayload(bytes.length) })),
    ),
    input: (bytes) => send({ channel, kind: FrameKind.Data, payload: bytes }),
    resize: (cols, rows) => send({ channel, kind: FrameKind.Resize, payload: resizePayload(cols, rows) }),
  } satisfies Attached
})

/** Scrollback lines hc paints before the screen, so a new viewer can scroll back. */
export const HISTORY_LINES = 1000

const AttachParams = S.Struct({
  terminal: S.String,
  cols: S.Int,
  rows: S.Int,
  resumed: S.optionalKey(S.Boolean),
  history: S.optionalKey(S.Int),
  observe: S.optionalKey(S.Boolean),
})
type AttachParams = typeof AttachParams.Type

const viewerParams = ({ terminal, cols, rows }: AttachRequest): AttachParams => ({ terminal, cols, rows, resumed: true, history: HISTORY_LINES })

const framedHello = method(
  "hello",
  S.Struct({ generation: S.Literal(1), framed: S.Literal(true) }),
  S.Struct({ generation: S.Literal(1) }),
)

const attachMethod = method(
  "terminal.attach",
  AttachParams,
  S.Struct({ channel: S.Int, terminal: S.Struct({ cols: S.Int, rows: S.Int }) }),
)

const encodeRequest = <P, A, AI>(m: Method<P, A, AI>, id: string, params: P) =>
  S.encodeEffect(m.request)({ jsonrpc: "2.0", id, method: m.name, params }).pipe(
    Effect.mapError((cause) => new HcProtocolError({ cause })),
  )

const decodeReply = (text: string) =>
  S.decodeEffect(S.fromJsonString(Reply))(text).pipe(Effect.mapError((cause) => new HcProtocolError({ cause })))
