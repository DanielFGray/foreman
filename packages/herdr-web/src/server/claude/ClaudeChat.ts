// A Claude Code agent's chat, followed live from its transcript.
//
// Claude Code writes `<config>/sessions/<pid>.json` for each running process,
// naming its session id, and appends the conversation to
// `<config>/projects/<project>/<session id>.jsonl`. Claude Code rewrites the
// pid record in place when the process starts another session (`/clear`
// does), so watching it moves the chat to the new transcript.
import { Array, Config, Context, Effect, FileSystem, Layer, Option, Result, Schedule, Schema, Stream } from "effect"
import type { ChatUpdate } from "../../shared/Chat.ts"
import { decodeLine, splitLines } from "./Transcript.ts"

/** The process has no session record Claude Code can be followed by. */
export class NoTranscript extends Schema.TaggedError<NoTranscript, { readonly brand: unique symbol }>()(
  "NoTranscript",
  { pid: Schema.Int, reason: Schema.String },
) {}

export class ClaudeChat extends Context.Service<ClaudeChat>()("herdr-web/server/claude/ClaudeChat", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const configDir = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
      Config.orElse(() => Config.String("HOME").pipe(Config.map((home) => `${home}/.claude`))),
    )

    const sessionId = (pid: number) =>
      fs.readFileString(`${configDir}/sessions/${pid}.json`).pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new NoTranscript({ pid, reason: "Claude Code has no session record for this process" })),
        ),
        Effect.flatMap((text) =>
          decodePidRecord(text).pipe(
            Effect.mapError(({ message }) => new NoTranscript({ pid, reason: `unreadable session record: ${message}` })),
          ),
        ),
        Effect.map(({ sessionId }) => sessionId),
      )

    const findTranscript = Effect.fnUntraced(function* (id: string) {
      const projects = `${configDir}/projects`
      // No projects folder yet means Claude Code has written no transcript.
      const folders = yield* fs.readDirectory(projects).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])))
      const found = yield* Effect.filter(folders, (folder) => fs.exists(`${projects}/${folder}/${id}.jsonl`))
      return Option.map(Array.head(found), (folder) => `${projects}/${folder}/${id}.jsonl`)
    })

    /** The transcript's path once it exists. */
    const awaitTranscript = (id: string) =>
      Stream.fromEffectSchedule(findTranscript(id), Schedule.spaced(TRANSCRIPT_CHECK)).pipe(
        Stream.filterMap(Result.fromOption(() => undefined)),
        Stream.take(1),
      )

    // A new session has no transcript until it writes its first line, so its
    // chat is empty until then.
    const session = (id: string) =>
      Stream.unwrap(
        Effect.map(
          findTranscript(id),
          Option.match({
            onSome: follow,
            onNone: () => Stream.concat(Stream.make(EMPTY), Stream.flatMap(awaitTranscript(id), follow)),
          }),
        ),
      )

    /** Reads the file's bytes from `from` to `to`. */
    const readRange = (path: string, from: bigint, to: bigint) =>
      fs.stream(path, { offset: from, bytesToRead: to - from }).pipe(
        Stream.runFold(() => new Uint8Array(), join),
      )

    const next = (path: string) =>
      Effect.fnUntraced(function* (tail: Tail) {
        const { size } = yield* fs.stat(path)
        if (Option.isNone(tail) || size < tail.value.offset) {
          const from = size > TAIL_BYTES ? size - TAIL_BYTES : 0n
          const bytes = yield* readRange(path, from, size)
          // Starting mid-file, the first line is cut; drop it.
          const whole = from === 0n ? bytes : bytes.subarray(bytes.indexOf(NEWLINE) + 1)
          const { lines, rest } = splitLines(new Uint8Array(), whole)
          return [Option.some({ offset: size, rest }), [reset(lines)]] as const
        }
        if (size === tail.value.offset) {
          return [tail, []] as const
        }
        const { lines, rest } = splitLines(tail.value.rest, yield* readRange(path, tail.value.offset, size))
        const entries = Array.flatMap(lines, decodeLine)
        const updates: ReadonlyArray<ChatUpdate> = Array.isArrayNonEmpty(entries) ? [{ _tag: "Appended", entries }] : []
        return [Option.some({ offset: size, rest }), updates] as const
      })

    // Every read goes to the file's current size, so an event missed between
    // the first read and the watch starting is caught up by the next one.
    const follow = (path: string) =>
      Stream.merge(Stream.make("start"), fs.watch(path)).pipe(Stream.mapAccumEffect((): Tail => Option.none(), (tail) => next(path)(tail)))

    /** The chat of the Claude Code process `pid`: its recent entries, then each batch of new ones. */
    const chat = (pid: number) =>
      Stream.merge(Stream.make("start"), fs.watch(`${configDir}/sessions/${pid}.json`)).pipe(
        Stream.mapEffect(() => sessionId(pid)),
        Stream.changes,
        Stream.switchMap(session),
      )

    return { chat }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

const PidRecord = Schema.Struct({ sessionId: Schema.String })
const decodePidRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(PidRecord))

/** Where the next read starts, and the bytes of a line not yet complete. None before the first read. */
type Tail = Option.Option<Readonly<{ offset: bigint; rest: Uint8Array }>>

/** How much of the transcript's end the first read takes: enough for the recent turns of a long session. */
const TAIL_BYTES = 4n * 1024n * 1024n
const NEWLINE = 0x0a
/** How often a new session is checked for its first transcript line. */
const TRANSCRIPT_CHECK = "1 second"
const EMPTY: ChatUpdate = { _tag: "Reset", entries: [] }

const reset = (lines: ReadonlyArray<string>): ChatUpdate => ({ _tag: "Reset", entries: Array.flatMap(lines, decodeLine) })

const join = (a: Uint8Array, b: Uint8Array) => {
  const bytes = new Uint8Array(a.length + b.length)
  bytes.set(a)
  bytes.set(b, a.length)
  return bytes
}
