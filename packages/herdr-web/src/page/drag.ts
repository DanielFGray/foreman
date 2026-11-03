// Model-driven dragging, after Horowitz, Blinn and Heer, "Declarative
// Dragging" (2026). On drag start the dragged element lists the states it can
// reach, each with the rectangle the page's own layout gives it there. While
// it is dragged, the element floats with the pointer, and the closest target
// within a snap radius is the preview. On release that target's drop runs;
// outside every radius nothing runs. The board's drag goes through here.
import { Array, Option, pipe } from "effect"
import type { Point } from "./model.ts"

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One state the dragged element can reach: where it is drawn there, and what a drop there does. */
export interface Target<A> {
  readonly rect: Rect
  readonly drop: A
}

/** The element as it floats: its rectangle at drag start, moved as far as the pointer moved. */
export const floating = (start: Rect, from: Point, at: Point): Rect => ({ ...start, x: start.x + at.x - from.x, y: start.y + at.y - from.y })

export const centreOf = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })

/** The target whose centre is nearest `at`, if it is within `radius`; the first wins a tie. */
export const closest = <A>(targets: ReadonlyArray<Target<A>>, at: Point, radius: number): Option.Option<Target<A>> =>
  pipe(
    targets,
    Array.map((target) => ({ target, distance: distanceOf(centreOf(target.rect), at) })),
    Array.filter(({ distance }) => distance <= radius),
    Array.reduce(Option.none<{ readonly target: Target<A>; readonly distance: number }>(), (best, next) =>
      Option.exists(best, ({ distance }) => distance <= next.distance) ? best : Option.some(next),
    ),
    Option.map(({ target }) => target),
  )

export const distanceOf = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
