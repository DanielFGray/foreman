// A Claude Code agent's chat, followed live from its transcript, and its
// task list (see Tasks.ts), which follows the same session.
//
// Claude Code writes `<config>/sessions/<pid>.json` for each running process,
// naming its session id, and appends the conversation to
// `<config>/projects/<project>/<session id>.jsonl`. Claude Code rewrites the
// pid record in place when the process starts another session (`/clear`
// does), so watching it moves the chat to the new transcript.
import { Array, Config, Context, Effect, FileSystem, Layer, Option, Result, Schedule, Schema, Stream } from "effect"
import type { ChatUpdate } from "../../shared/Chat.ts"
import { sameTodos } from "../../shared/Todo.ts"
import { decodeTaskFile, isTaskFile, todosOf } from "./Tasks.ts"
import { decodeLine, newestModel, splitLines } from "./Transcript.ts"

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
          return step(Option.some({ offset: size, rest }), [{ isReset: true, lines }])
        }
        if (size === tail.value.offset) {
          return step(tail, [])
        }
        const { lines, rest } = splitLines(tail.value.rest, yield* readRange(path, tail.value.offset, size))
        return step(Option.some({ offset: size, rest }), Array.isArrayNonEmpty(lines) ? [{ isReset: false, lines }] : [])
      })

    // Every read goes to the file's current size, so an event missed between
    // the first read and the watch starting is caught up by the next one.
    const follow = (path: string) =>
      Stream.merge(Stream.make("start"), fs.watch(path)).pipe(Stream.mapAccumEffect((): Tail => Option.none(), (tail) => next(path)(tail)))

    // The session id of the Claude Code process `pid`, and again each time it starts another session.
    const sessions = (pid: number) =>
      Stream.merge(Stream.make("start"), fs.watch(`${configDir}/sessions/${pid}.json`)).pipe(Stream.mapEffect(() => sessionId(pid)), Stream.changes)

    // The transcript lines of the Claude Code process `pid`: its recent ones, then each batch of new ones.
    const lines = (pid: number) => Stream.switchMap(sessions(pid), session)

    /**
     * The session's task list now. A list with no folder yet has no tasks, and
     * a task deleted after the folder was listed is gone. Claude Code may be
     * writing a file while it is read, so a read that cannot be decoded is
     * tried again once.
     */
    const tasksOf = (pid: number, id: string) => {
      const folder = `${configDir}/tasks/${id}`
      const taskIn = (name: string) =>
        fs.readFileString(`${folder}/${name}`).pipe(
          Effect.asSome,
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
          Effect.flatMap((text) => Effect.transposeOption(Option.map(text, decodeTaskFile))),
          Effect.mapError(({ message }) => new NoTranscript({ pid, reason: `unreadable task ${name}: ${message}` })),
        )
      return fs.readDirectory(folder).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
        Effect.flatMap((names) => Effect.forEach(Array.filter(names, isTaskFile), taskIn)),
        Effect.map((tasks) => todosOf(Array.getSomes(tasks))),
        Effect.retry({ times: 1, schedule: Schedule.spaced(TORN_READ_WAIT) }),
      )
    }

    return {
      /** The chat of the Claude Code process `pid`: its recent entries, then each batch of new ones. */
      chat: (pid: number) => Stream.filterMap(lines(pid), toUpdate),
      /**
       * The task list of the Claude Code process `pid`, then after each change.
       * Polled: Claude Code makes the list's folder only with its first task.
       */
      todos: (pid: number) =>
        sessions(pid).pipe(
          Stream.switchMap((id) => Stream.fromEffectSchedule(tasksOf(pid, id), Schedule.spaced(TASKS_POLL))),
          Stream.changesWith(sameTodos),
        ),
      /**
       * The id of the model that wrote the newest reply, such as
       * `claude-opus-5-5`, each time it changes. None until the session's first reply.
       */
      model: (pid: number) =>
        lines(pid).pipe(
          Stream.mapAccum(
            (): Option.Option<string> => Option.none(),
            (last, { isReset, lines }) => {
              // Lines that replace all read before forget the model read before.
              const next = newestModel(lines, isReset ? Option.none() : last)
              return [next, [next]] as const
            },
          ),
          Stream.changes,
        ),
    }
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
/** How often the task list is read. */
const TASKS_POLL = "1 second"
/** How long a task read that cannot be decoded waits before it is tried again. */
const TORN_READ_WAIT = "100 millis"
/** Lines read from the transcript; `isReset` when they replace all read before. */
type Lines = Readonly<{ isReset: boolean; lines: ReadonlyArray<string> }>

const step = (tail: Tail, batches: ReadonlyArray<Lines>) => [tail, batches] as const

const EMPTY: Lines = { isReset: true, lines: [] }

// A reset always reaches the page, even with no entries; a batch of appended lines only when it holds one.
const toUpdate = ({ isReset, lines }: Lines): Result.Result<ChatUpdate, void> => {
  const entries = Array.flatMap(lines, decodeLine)
  return isReset
    ? Result.succeed({ _tag: "Reset", entries })
    : Array.isArrayNonEmpty(entries)
      ? Result.succeed({ _tag: "Appended", entries })
      : Result.fail(undefined)
}

const join = (a: Uint8Array, b: Uint8Array) => {
  const bytes = new Uint8Array(a.length + b.length)
  bytes.set(a)
  bytes.set(b, a.length)
  return bytes
}
