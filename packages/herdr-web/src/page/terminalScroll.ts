// Scrolling a terminal with the wheel or a finger. ghostty-web scrolls its own
// scrollback for a wheel, sends arrow keys on the alternate screen, and takes
// no touch drag at all. A full-screen program that asked for mouse reports,
// as Claude Code does, scrolls its own view on wheel reports and reads arrow
// keys as its prompt history. So the page decides, for the wheel and for a
// finger dragged up or down alike: wheel reports to a program that asked for
// them, arrow keys on the alternate screen, else the scrollback.
import { Effect, MutableRef, Option } from "effect"
import type { Terminal } from "ghostty-web"

/**
 * Scrolls the terminal for each wheel turn and each vertical drag of one
 * finger, for as long as the scope lasts. What the program must read goes to
 * `send`. While the box around the canvas can still scroll in the drag's
 * direction (a watching page keeps the terminal's own size), the drag scrolls
 * the box instead. A drag never reaches ghostty-web, which would open the
 * keyboard at its end; a tap does.
 */
export const scrollByWheelAndTouch = (terminal: Terminal, element: HTMLElement, send: (data: string) => void) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const scroll = (lines: number, point: Point) =>
        Option.match(scrollInput(modesOf(terminal), lines, cellAt(terminal, element, point)), {
          onNone: () => terminal.scrollLines(lines),
          onSome: send,
        })
      // A program that asked for reports gets them; anything else, ghostty-web does as before.
      const wheelRest = MutableRef.make(0)
      terminal.attachCustomWheelEventHandler((event) => {
        if (!terminal.hasMouseTracking()) {
          return false
        }
        const lines = MutableRef.get(wheelRest) + linesOf(event, cellHeight(terminal, element), terminal.rows)
        MutableRef.set(wheelRest, lines % 1)
        scroll(Math.trunc(lines), { x: event.clientX, y: event.clientY })
        return true
      })

      const drag = MutableRef.make(Option.none<Drag>())
      const onStart = (event: TouchEvent) => {
        MutableRef.set(
          drag,
          Option.map(Option.filter(Option.fromNullishOr(event.touches[0]), () => event.touches.length === 1), (touch): Drag => ({
            start: { x: touch.clientX, y: touch.clientY },
            last: touch.clientY,
            rest: 0,
            by: "Undecided",
          })),
        )
      }
      const onMove = (event: TouchEvent) => {
        MutableRef.update(drag, Option.flatMap((now) =>
          Option.map(Option.fromNullishOr(event.touches[0]), (touch): Drag => {
            const moved = touch.clientY - now.last
            const by = now.by === "Undecided" && moved !== 0 ? (boxScrolls(element, moved) ? "Box" : "Terminal") : now.by
            if (by !== "Terminal") {
              return { ...now, last: touch.clientY, by }
            }
            event.preventDefault()
            // A finger moving down shows what came before, as a wheel turned up does.
            const cells = now.rest - moved / cellHeight(terminal, element)
            scroll(Math.trunc(cells), { x: touch.clientX, y: touch.clientY })
            return { ...now, last: touch.clientY, rest: cells % 1, by }
          }),
        ))
      }
      const onEnd = (event: TouchEvent) => {
        const touch = Option.fromNullishOr(event.changedTouches[0])
        if (Option.exists(Option.flatMap(MutableRef.get(drag), (now) => Option.map(touch, (end) => Math.hypot(end.clientX - now.start.x, end.clientY - now.start.y))), (far) => far > TAP_DISTANCE)) {
          // The browser lets no one cancel the end of a drag it scrolled the box with.
          if (event.cancelable) {
            event.preventDefault()
          }
          event.stopPropagation()
        }
        MutableRef.set(drag, Option.none())
      }
      element.addEventListener("touchstart", onStart, { passive: true })
      element.addEventListener("touchmove", onMove, { passive: false })
      element.addEventListener("touchend", onEnd, { capture: true })
      return () => {
        terminal.attachCustomWheelEventHandler(undefined)
        element.removeEventListener("touchstart", onStart)
        element.removeEventListener("touchmove", onMove)
        element.removeEventListener("touchend", onEnd, { capture: true })
      }
    }),
    (remove) => Effect.sync(remove),
  )

/** The modes a program set that decide what a scroll sends it. */
export type Modes = Readonly<{ reports: boolean; sgr: boolean; alternate: boolean; appCursor: boolean }>

/**
 * What the program reads for a scroll of `lines` (negative: back, up) at a
 * cell: a wheel report per line, or on the alternate screen an arrow key per
 * line. None: the scroll is the terminal's own, through its scrollback.
 */
export const scrollInput = (modes: Modes, lines: number, cell: Point): Option.Option<string> =>
  lines === 0
    ? Option.none()
    : modes.reports
      ? Option.some(wheelReport(modes.sgr, lines < 0 ? WHEEL_UP : WHEEL_DOWN, cell).repeat(Math.abs(lines)))
      : modes.alternate
        ? Option.some(`\x1b${modes.appCursor ? "O" : "["}${lines < 0 ? "A" : "B"}`.repeat(Math.abs(lines)))
        : Option.none()

/** A point on the page in pixels, or a cell as column x and row y from the screen's top-left, from 0. */
type Point = Readonly<{ x: number; y: number }>

type Drag = Readonly<{ start: Point; last: number; rest: number; by: "Undecided" | "Box" | "Terminal" }>

// SGR reports (mode 1006) give the cell in decimal; the older form gives each
// number as one byte from 32, so it cannot name a cell past 223.
const wheelReport = (sgr: boolean, button: number, { x, y }: Point) =>
  sgr ? `\x1b[<${button};${x + 1};${y + 1}M` : `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(x + 1, 223), 32 + Math.min(y + 1, 223))}`

const WHEEL_UP = 64
const WHEEL_DOWN = 65

const modesOf = (terminal: Terminal): Modes => ({
  reports: terminal.hasMouseTracking(),
  sgr: terminal.getMode(1006),
  alternate: terminal.getMode(1049) || terminal.getMode(1047),
  appCursor: terminal.getMode(1),
})

const canvasRect = (element: HTMLElement) => Option.map(Option.fromNullishOr(element.querySelector("canvas")), (canvas) => canvas.getBoundingClientRect())

/** The height of a row on the page; the canvas may be scaled by the stylesheet. */
const cellHeight = (terminal: Terminal, element: HTMLElement) =>
  Option.match(canvasRect(element), { onNone: () => FALLBACK_CELL_HEIGHT, onSome: ({ height }) => height / terminal.rows })

/** The cell under a point, held to the screen. */
const cellAt = (terminal: Terminal, element: HTMLElement, point: Point): Point =>
  Option.match(canvasRect(element), {
    onNone: () => ({ x: 0, y: 0 }),
    onSome: ({ left, top, width, height }) => ({
      x: clamp(Math.floor(((point.x - left) / width) * terminal.cols), terminal.cols - 1),
      y: clamp(Math.floor(((point.y - top) / height) * terminal.rows), terminal.rows - 1),
    }),
  })

const clamp = (value: number, most: number) => Math.max(0, Math.min(value, most))

const linesOf = (event: WheelEvent, rowHeight: number, rows: number) =>
  event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * rows : event.deltaY / rowHeight

/** Whether the box can scroll further the way a finger moving by `moved` pixels pushes it. */
const boxScrolls = (element: HTMLElement, moved: number) =>
  moved > 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1

/** Pixels a touch may move and still be a tap, as in terminalLinks.ts. */
const TAP_DISTANCE = 10
const FALLBACK_CELL_HEIGHT = 16
