// Links in a terminal's output. ghostty-web opens a link at a Ctrl or Cmd
// click, of any scheme and without asking; a phone's tap never reaches it,
// since ghostty-web cancels the touch to keep the keyboard. So the page takes
// both: a tap, or a Ctrl or Cmd click, on a link reports the link's address,
// and the page shows it before anything opens.
import { Array, Effect, Option, Queue, Stream } from "effect"
import { type ILink, OSC8LinkProvider, type Terminal, UrlRegexProvider } from "ghostty-web"

/** The address of a link at a point, as the terminal's output gave it. */
export type PointedLink = Readonly<{ uri: string }>

/**
 * Reports the address of each link tapped or Ctrl/Cmd-clicked in the
 * terminal, for as long as the scope lasts. The click goes no further, so
 * ghostty-web does not open it too.
 */
export const watchLinks = (terminal: Terminal, element: HTMLElement, report: (link: PointedLink) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const pointers = yield* Queue.unbounded<Pointer>()
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onDown = (event: PointerEvent) => event.pointerType === "touch" && Queue.offerUnsafe(pointers, pointerOf("Down", event.pointerId, event))
        const onUp = (event: PointerEvent) => event.pointerType === "touch" && Queue.offerUnsafe(pointers, pointerOf("Up", event.pointerId, event))
        const onClick = (event: MouseEvent) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            event.stopPropagation()
            Queue.offerUnsafe(pointers, pointerOf("Click", 0, event))
          }
        }
        element.addEventListener("pointerdown", onDown)
        element.addEventListener("pointerup", onUp)
        element.addEventListener("click", onClick, { capture: true })
        return () => {
          element.removeEventListener("pointerdown", onDown)
          element.removeEventListener("pointerup", onUp)
          element.removeEventListener("click", onClick, { capture: true })
        }
      }),
      (remove) => Effect.sync(remove),
    )
    const providers = [new OSC8LinkProvider(terminal), new UrlRegexProvider(terminal)]
    yield* Stream.fromQueue(pointers).pipe(
      Stream.mapAccum(() => Option.none<Pointer>(), (down, pointer) => [pointer._tag === "Down" ? Option.some(pointer) : Option.none(), Option.toArray(pointedAt(down, pointer))]),
      Stream.runForEach((point) =>
        Option.match(Option.flatMap(canvasOf(element), (canvas) => cellAt(gridOf(terminal, canvas), point)), {
          onNone: () => Effect.void,
          onSome: (cell) => Effect.flatMap(linkAt(providers, cell), Option.match({ onNone: () => Effect.void, onSome: ({ text }) => report({ uri: text }) })),
        }),
      ),
      Effect.forkScoped,
    )
  })

/** The address the page may open: an http or https one, as the browser writes it. */
export const webAddress = (uri: string): Option.Option<string> =>
  Option.liftThrowable(() => new URL(uri))().pipe(
    Option.filter(({ protocol }) => protocol === "http:" || protocol === "https:"),
    Option.map(({ href }) => href),
  )

/** Where the terminal's canvas is on the page, its size in cells, and how far it is scrolled back. */
export type Grid = Readonly<{ left: number; top: number; width: number; height: number; cols: number; rows: number; viewportY: number; scrollback: number }>

/**
 * The cell under a point on the page, its row counted from the top of the
 * scrollback, as ghostty-web counts rows. The cell size comes from the
 * canvas's size on the page, so a canvas scaled by the stylesheet maps too.
 */
export const cellAt = (grid: Grid, point: Position): Option.Option<Position> => {
  const col = Math.floor(((point.x - grid.left) / grid.width) * grid.cols)
  const onScreen = Math.floor(((point.y - grid.top) / grid.height) * grid.rows)
  return col >= 0 && col < grid.cols && onScreen >= 0 && onScreen < grid.rows
    ? Option.some({ x: col, y: grid.scrollback - Math.max(0, Math.floor(grid.viewportY)) + onScreen })
    : Option.none()
}

/**
 * A tap is a touch that ends near where it began, soon after; a touch that
 * moves further is a scroll. A Ctrl or Cmd click points where it is.
 */
export const pointedAt = (down: Option.Option<Pointer>, pointer: Pointer): Option.Option<Position> =>
  pointer._tag === "Click"
    ? Option.some(pointer)
    : pointer._tag === "Up"
      ? Option.filter(down, (start) => start.id === pointer.id && Math.hypot(pointer.x - start.x, pointer.y - start.y) <= TAP_DISTANCE && pointer.at - start.at <= TAP_TIME).pipe(
          Option.map(() => pointer),
        )
      : Option.none()

export type Pointer = Readonly<{ _tag: "Down" | "Up" | "Click"; id: number; x: number; y: number; at: number }>

/** A point on the page in pixels, or a cell as column x and row y. */
type Position = Readonly<{ x: number; y: number }>

/** Pixels a tap may move, and milliseconds it may last. */
const TAP_DISTANCE = 10
const TAP_TIME = 500

const pointerOf = (tag: Pointer["_tag"], id: number, event: MouseEvent): Pointer => ({
  _tag: tag,
  id,
  x: event.clientX,
  y: event.clientY,
  at: event.timeStamp,
})

const canvasOf = (element: HTMLElement) => Option.fromNullishOr(element.querySelector("canvas"))

const gridOf = (terminal: Terminal, canvas: HTMLCanvasElement): Grid => {
  const { left, top, width, height } = canvas.getBoundingClientRect()
  return { left, top, width, height, cols: terminal.cols, rows: terminal.rows, viewportY: terminal.getViewportY(), scrollback: terminal.getScrollbackLength() }
}

// Each provider reads the row and names its links, OSC 8 ones first; the first
// that holds the cell wins. ghostty-web 0.4.0 keeps an OSC 8 link's id but not
// its address (getHyperlinkUri gives null), so until it does, only addresses
// written out in the text are found.
const linkAt = (providers: ReadonlyArray<OSC8LinkProvider | UrlRegexProvider>, cell: Position) =>
  Effect.map(
    Effect.forEach(providers, (provider) =>
      Effect.callback<ReadonlyArray<ILink>>((resume) => provider.provideLinks(cell.y, (links) => resume(Effect.succeed(links ?? [])))),
    ),
    (found) => Array.findFirst(Array.flatten(found), ({ range: { start, end } }) => !isBefore(cell, start) && !isBefore(end, cell)),
  )

const isBefore = (a: Position, b: Position) => a.y < b.y || (a.y === b.y && a.x < b.x)
