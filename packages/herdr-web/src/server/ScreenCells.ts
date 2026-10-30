// A terminal's screen with the styles of its cells, which hc's terminal.read
// leaves out. The bridge watches the terminal without typing into it or
// setting its size, replays hc's first paint into a headless terminal of the
// same size, and reads the cells back.
import { Array, Config, Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { CellFlags, Ghostty, type GhosttyTerminal } from "ghostty-web"
import { observe, type Size } from "../hc/Attach.ts"
import type { Screen } from "./claude/InputBox.ts"

class NoTerminalEmulator extends Schema.TaggedError<NoTerminalEmulator, { readonly brand: unique symbol }>()("NoTerminalEmulator", { cause: Schema.Defect() }) {}

export class ScreenCells extends Context.Service<ScreenCells>()("herdr-web/server/ScreenCells", {
  make: Effect.gen(function* () {
    const runtime = yield* Config.String("XDG_RUNTIME_DIR")
    const path = `${runtime}/herdr-core/default.sock`
    const ghostty = yield* Effect.tryPromise({
      try: () => Ghostty.load(new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm")).pathname),
      catch: (cause) => new NoTerminalEmulator({ cause }),
    })
    return {
      /** The terminal's screen now, row by row. */
      read: (terminal: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const watched = yield* observe(path, terminal)
            const paint = yield* firstPaint(watched.output)
            const headless = yield* Effect.acquireRelease(
              Effect.sync(() => ghostty.createTerminal(watched.size.cols, watched.size.rows)),
              (made) => Effect.sync(() => made.free()),
            )
            return render(headless, watched.size, paint)
          }),
        ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/**
 * hc sends the first paint in a burst of frames, then only what the program
 * writes. The paint has ended when the output pauses; a program that keeps
 * writing ends it at the bound instead, which shows its screen as of then.
 */
const firstPaint = <E>(output: Stream.Stream<Uint8Array, E>) =>
  output.pipe(
    Stream.scan(() => new Uint8Array(), concat),
    Stream.debounce(PAUSE),
    Stream.runHead,
    Effect.timeoutOption(BOUND),
    Effect.map((paint) => Option.getOrElse(Option.flatten(paint), () => new Uint8Array())),
  )

/** The cells a headless terminal shows after it draws `paint`. */
export const render = (terminal: GhosttyTerminal, { rows }: Size, paint: Uint8Array | string): Screen => {
  terminal.write(paint)
  return Array.map(Array.makeBy(rows, (y) => y), (y) =>
    Array.map(
      // A wide character's second cell has width 0 and no character of its own.
      Array.filter(Option.getOrElse(Option.fromNullOr(terminal.getLine(y)), () => []), ({ width }) => width > 0),
      ({ codepoint, flags }) => ({
        char: codepoint === 0 ? " " : String.fromCodePoint(codepoint),
        faint: (flags & CellFlags.FAINT) !== 0,
        inverse: (flags & CellFlags.INVERSE) !== 0,
      }),
    ),
  )
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const both = new Uint8Array(a.length + b.length)
  both.set(a)
  both.set(b, a.length)
  return both
}

const PAUSE = "60 millis"
const BOUND = "1 second"
