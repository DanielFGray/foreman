// The task board: each task of the column's scope in the column foreman puts
// it in, for use from a phone. The board computes no column and copies no
// foreman rule: a card's column is its placement's `column` in the reading,
// and Landed is the reading's `landed`. A drag runs a foreman command, and the
// next reading moves the card.
//
// One layout (`layoutOf`) places every card, and the drag asks the same
// layout where a card would stand in each state it can reach (see drag.ts).
import { Array, Option, pipe, Record } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { BOARD_COLUMNS, type BoardColumn, type ForemanCommand, type ForemanReading, type ForemanRow } from "../shared/Foreman.ts"
import { CapturePointer } from "./commands.ts"
import { centreOf, closest, distanceOf, floating, type Rect, type Target } from "./drag.ts"
import { clickedForemanCommand, isInScope, rowButtonsView, withPage } from "./foreman.ts"
import { BoardDrag, Message, type Model, NO_SCROLL, type Point, type UpdateReturn } from "./model.ts"
import { ago } from "./usage.ts"

/** How long a finger holds a card still before it drags; a shorter press that moves is a scroll. */
export const HOLD_MS = 300

/** How far a held finger may move, in CSS pixels, before the press counts as a scroll. */
const SLOP = 8

/** How near a target's centre the dragged card's centre must come to snap to it. */
const SNAP_RADIUS = 120

const COLUMN_WIDTH = 220
const COLUMN_GAP = 8
const HEAD_HEIGHT = 32
const CARD_HEIGHT = 64
/** A Needs-you card holds the attention row's detail and its buttons too. */
const ASKING_CARD_HEIGHT = 148
const CARD_GAP = 6

const TITLES: Record<BoardColumn, string> = {
  queue: "Queue",
  "needs-you": "Needs you",
  authoring: "Authoring",
  review: "Review",
  fixing: "Fixing",
  landed: "Landed",
}

export interface Card {
  readonly key: string
  readonly label: string
  readonly project: string
  readonly column: BoardColumn
  /** When it landed, for a Landed card. */
  readonly landedAt: Option.Option<string>
}

/**
 * The cards of the column's scope, in the reading's order. A placement in the
 * landed column is not drawn: Landed shows the reading's `landed`, which holds
 * the task once foreman has settled it.
 */
export const cardsOf = (model: Model, reading: ForemanReading): ReadonlyArray<Card> => [
  ...pipe(
    reading.placements,
    Array.filter((placed) => placed.column !== "landed" && isInScope(model, Option.some(placed.project))),
    Array.map((placed): Card => ({ ...placed, landedAt: Option.none() })),
  ),
  ...pipe(
    reading.landed,
    Array.filter((done) => isInScope(model, Option.some(done.project))),
    Array.map((done): Card => ({ key: done.key, label: done.label, project: done.project, column: "landed", landedAt: Option.some(done.landedAt) })),
  ),
]

/** Where each card stands, in the coordinates of the board's row of columns before any column scrolls. */
export interface Layout {
  readonly width: number
  readonly placed: ReadonlyArray<{ readonly card: Card; readonly rect: Rect }>
}

export const layoutOf = (cards: ReadonlyArray<Card>): Layout => {
  // How far down each column its next card goes; a column with no card yet starts at the top.
  const filled = new Map<BoardColumn, number>()
  const placed = Array.map(cards, (card) => {
    const height = card.column === "needs-you" ? ASKING_CARD_HEIGHT : CARD_HEIGHT
    const top = filled.get(card.column) ?? 0
    filled.set(card.column, top + height + CARD_GAP)
    return { card, rect: { x: leftOf(card.column), y: HEAD_HEIGHT + top, width: COLUMN_WIDTH, height } }
  })
  return { width: BOARD_COLUMNS.length * (COLUMN_WIDTH + COLUMN_GAP) - COLUMN_GAP, placed }
}

const leftOf = (column: BoardColumn): number => BOARD_COLUMNS.indexOf(column) * (COLUMN_WIDTH + COLUMN_GAP)

/** A drag in progress: where the card stood when it began, and the states it can reach. */
export interface Reach {
  readonly start: Rect
  readonly targets: ReadonlyArray<Target<Option.Option<ForemanCommand>>>
}

/**
 * The states a card can reach by a drag: where it stands, and for a Queue card
 * whose project has `grantSteps`, Authoring, which a grant of those steps
 * lets the dispatcher start. Any other card takes no drag.
 */
export const reachOf = (model: Model, reading: ForemanReading, key: string): Option.Option<Reach> => {
  const cards = cardsOf(model, reading)
  return pipe(
    Array.findFirst(cards, (card) => card.key === key && card.column === "queue"),
    Option.flatMap((card) =>
      pipe(
        Array.findFirst(reading.projects, (project) => project.name === card.project),
        Option.flatMap(({ grantSteps }) => (Array.isReadonlyArrayNonEmpty(grantSteps) ? Option.some(grantSteps) : Option.none())),
        Option.flatMap((steps) => {
          const scrolled = model.foremanPage.scrolled
          const moved: Card = { ...card, column: "authoring" }
          return Option.map(
            Option.all({ here: rectIn(layoutOf(cards), key, scrolled), there: rectIn(layoutOf([...Array.filter(cards, (other) => other.key !== key), moved]), key, scrolled) }),
            ({ here, there }): Reach => ({
              start: here,
              targets: [
                { rect: here, drop: Option.none() },
                { rect: there, drop: Option.some({ _tag: "Grant", scope: key, steps }) },
              ],
            }),
          )
        }),
      ),
    ),
  )
}

// A card's rectangle where its column is scrolled: the drag works in what the page shows.
const rectIn = (layout: Layout, key: string, scrolled: Record<BoardColumn, number>): Option.Option<Rect> =>
  Option.map(Array.findFirst(layout.placed, ({ card }) => card.key === key), ({ card, rect }) => ({ ...rect, y: rect.y - scrolled[card.column] }))

/** The target the card would drop on now, if any. */
const snappedOf = (reach: Reach, start: Point, at: Point) => closest(reach.targets, centreOf(floating(reach.start, start, at)), SNAP_RADIUS)

// ── updates ──

const withDrag = (model: Model, drag: BoardDrag): Model => withPage(model, (page) => ({ ...page, drag }))

const readingOf = (model: Model): Option.Option<ForemanReading> => Option.flatMap(model.foreman, (state) => state.reading)

/** Shows or hides the board. A board shown again has new columns at the top, so the scroll the page kept starts over. */
export const toggledBoard = (model: Model): Model => withPage(model, (page) => ({ ...page, isBoardShown: !page.isBoardShown, drag: BoardDrag.Idle(), scrolled: NO_SCROLL }))

/** A press on a card: a touch waits to be held, a mouse or pen drags at once. A card that can reach nothing takes no press. */
export const pressedCard = (model: Model, key: string, pointerId: number, pointerType: string, at: Point): UpdateReturn => {
  if (!Option.exists(readingOf(model), (reading) => Option.isSome(reachOf(model, reading, key)))) return { model }
  return pointerType === "touch"
    ? { model: withDrag(model, BoardDrag.Pressed({ key, pointerId, start: at })) }
    : { model: withDrag(model, BoardDrag.Dragging({ key, pointerId, start: at, at })), commands: [CapturePointer({ elementId: cardId(key), pointerId })] }
}

export const heldCard = (model: Model, key: string): UpdateReturn => {
  const drag = model.foremanPage.drag
  if (drag._tag !== "Pressed" || drag.key !== key) return { model }
  return {
    model: withDrag(model, BoardDrag.Dragging({ key, pointerId: drag.pointerId, start: drag.start, at: drag.start })),
    commands: [CapturePointer({ elementId: cardId(key), pointerId: drag.pointerId })],
  }
}

export const movedPointer = (model: Model, at: Point): Model => {
  const drag = model.foremanPage.drag
  switch (drag._tag) {
    case "Idle":
      return model
    case "Pressed":
      return distanceOf(drag.start, at) > SLOP ? withDrag(model, BoardDrag.Idle()) : model
    case "Dragging":
      return withDrag(model, { ...drag, at })
  }
}

/** The pointer went up: a dragged card runs the command of the target it snapped to, if any. */
export const releasedPointer = (model: Model): UpdateReturn => {
  const drag = model.foremanPage.drag
  const idle = withDrag(model, BoardDrag.Idle())
  if (drag._tag !== "Dragging") return { model: idle }
  return pipe(
    readingOf(model),
    Option.flatMap((reading) => reachOf(model, reading, drag.key)),
    Option.flatMap((reach) => snappedOf(reach, drag.start, drag.at)),
    Option.flatMap(({ drop }) => drop),
    Option.match({ onNone: () => ({ model: idle }), onSome: (command) => clickedForemanCommand(idle, command) }),
  )
}

export const canceledPointer = (model: Model): Model => withDrag(model, BoardDrag.Idle())

export const scrolledColumn = (model: Model, column: BoardColumn, top: number): Model =>
  withPage(model, (page) => ({ ...page, scrolled: { ...page.scrolled, [column]: top } }))

// ── view ──

export const cardId = (key: string) => `board-card-${key}`

/** The board in place of the column's sections, with why a project in scope is stopped, if one is. */
export const boardView = (model: Model, reading: ForemanReading, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const cards = cardsOf(model, reading)
  const layout = layoutOf(cards)
  const stopped = Array.filter(reading.stopped, ({ project }) => isInScope(model, Option.some(project)))
  return [
    ...Array.map(stopped, ({ project, problems }) =>
      h.section(
        [h.Class("board-stopped"), h.Role("alert"), h.AriaLabel(`${project} is stopped`)],
        [
          h.p([h.Class("note error")], [`The pipeline of ${project} is stopped, so no task takes a step.`]),
          h.ul([], Array.map(problems, (problem) => h.li([], [problem]))),
        ],
      ),
    ),
    h.div(
      [h.Class("board-scroll")],
      [
        h.div(
          [h.Class("board"), h.AriaLabel("Task board"), h.Style({ width: `${layout.width}px`, gap: `${COLUMN_GAP}px` })],
          [
            ...Array.map(BOARD_COLUMNS, (column) =>
              columnView(
                column,
                Array.filter(layout.placed, ({ card }) => card.column === column),
                model,
                reading,
                h,
              ),
            ),
            ...floatingView(model, reading, cards, h),
          ],
        ),
      ],
    ),
  ]
}

const columnView = (
  column: BoardColumn,
  placed: Layout["placed"],
  model: Model,
  reading: ForemanReading,
  h: HtmlBuilder<Message>,
): Html => {
  const { drag } = model.foremanPage
  const isMovable = (card: Card) => Option.isSome(reachOf(model, reading, card.key))
  const body = (card: Card) => cardBody(card, Array.findFirst(reading.rows, (row) => row.view === "attention" && row.key === card.key), model, h)
  return h.keyed("section")(
    column,
    [h.Class(`board-column ${column}`), h.AriaLabel(TITLES[column]), h.Style({ width: `${COLUMN_WIDTH}px` })],
    [
      h.h3([h.Class("board-head"), h.Style({ height: `${HEAD_HEIGHT}px` })], [TITLES[column], " ", h.span([h.Class("count")], [String(placed.length)])]),
      h.div(
        [h.Class("board-body"), h.OnScroll((top) => Message.ScrolledBoardColumn({ column, top }))],
        [
          h.ul(
            [h.Class("board-cards"), h.Style({ height: `${Option.match(Array.last(placed), { onNone: () => 0, onSome: ({ rect }) => rect.y + rect.height - HEAD_HEIGHT })}px` })],
            Array.map(placed, ({ card, rect }) => {
              const isDragged = drag._tag === "Dragging" && drag.key === card.key
              return h.keyed("li")(
                card.key,
                [
                  h.Id(cardId(card.key)),
                  h.Class(isDragged ? "board-card movable dragged" : isMovable(card) ? "board-card movable" : "board-card"),
                  h.Style({ top: `${rect.y - HEAD_HEIGHT}px`, height: `${rect.height}px` }),
                  ...(isMovable(card)
                    ? [
                        h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX, clientY, pointerId) =>
                          button === 0 ? Option.some(Message.PressedCard({ key: card.key, pointerId, pointerType, at: { x: clientX, y: clientY } })) : Option.none(),
                        ),
                      ]
                    : []),
                ],
                body(card),
              )
            }),
          ),
        ],
      ),
    ],
  )
}

const cardBody = (card: Card, row: Option.Option<ForemanRow>, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.div([h.Class("board-card-head")], [h.span([h.Class("foreman-key")], [card.key]), h.span([h.Class("note")], [card.project])]),
  h.div([h.Class("board-label"), h.Title(card.label)], [card.label]),
  ...Option.match(card.landedAt, { onNone: () => [], onSome: (at) => [h.span([h.Class("note")], [`landed ${ago(Date.parse(at), model.now)} ago`])] }),
  ...(card.column === "needs-you"
    ? Option.match(row, {
        onNone: () => [],
        onSome: (asking) => [
          ...Option.match(asking.detail, { onNone: () => [], onSome: (detail) => [h.div([h.Class("board-detail"), h.Title(detail)], [detail])] }),
          h.div([h.Class("foreman-actions")], rowButtonsView(asking, model.foremanPage, h)),
        ],
      })
    : []),
]

/** While a card drags: the target it would drop on, outlined where the layout puts it there, and the card following the pointer. */
const floatingView = (model: Model, reading: ForemanReading, cards: ReadonlyArray<Card>, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const drag = model.foremanPage.drag
  if (drag._tag !== "Dragging") return []
  return pipe(
    Option.all({ reach: reachOf(model, reading, drag.key), card: Array.findFirst(cards, (card) => card.key === drag.key) }),
    Option.match({
      onNone: () => [],
      onSome: ({ reach, card }) => {
        const snapped = snappedOf(reach, drag.start, drag.at)
        return [
          ...Option.match(snapped, { onNone: () => [], onSome: ({ rect }) => [h.div([h.Class("board-preview"), h.AriaHidden(true), h.Style(placed(rect))], [])] }),
          h.div(
            [h.Class(Option.exists(snapped, ({ drop }) => Option.isSome(drop)) ? "board-card floating snapped" : "board-card floating"), h.AriaHidden(true), h.Style(placed(floating(reach.start, drag.start, drag.at)))],
            cardBody(card, Option.none(), model, h),
          ),
        ]
      },
    }),
  )
}

const placed = (rect: Rect) => ({ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
