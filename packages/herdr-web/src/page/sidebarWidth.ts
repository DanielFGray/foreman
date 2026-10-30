// The sidebar's width on a desk, when its edge was dragged: kept per browser,
// as Ovis and herdr-app keep it. A phone's drawer keeps its own width.
import { Match, Option, Schema as S } from "effect"
import { loadStored, saveStored } from "./stored.ts"

/** The width the stylesheet gives the sidebar until its edge is dragged. */
export const DEFAULT_SIDEBAR_WIDTH = 340
export const MIN_SIDEBAR_WIDTH = 200
export const MAX_SIDEBAR_WIDTH = 560
/** One arrow key press on the focused edge. */
const STEP = 16

const STORAGE_KEY = "herdr-web.sidebar-width"
const Width = S.OptionFromNullOr(S.Int)

/** Within the limits, in whole pixels. The stylesheet also keeps it under half the window. */
export const clampSidebarWidth = (width: number) => Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)))

/** Where a key moves the edge from `width`; none for a key that is not the edge's. */
export const keyedSidebarWidth = (width: number, key: string): Option.Option<number> =>
  Match.value(key).pipe(
    Match.when("ArrowLeft", () => Option.some(clampSidebarWidth(width - STEP))),
    Match.when("ArrowRight", () => Option.some(clampSidebarWidth(width + STEP))),
    Match.when("Home", () => Option.some(MIN_SIDEBAR_WIDTH)),
    Match.when("End", () => Option.some(MAX_SIDEBAR_WIDTH)),
    Match.orElse(() => Option.none()),
  )

/** The kept width; none means the stylesheet's own. */
export const loadSidebarWidth = loadStored(STORAGE_KEY, Width, Option.none())

export const saveSidebarWidth = (width: Option.Option<number>) => saveStored(STORAGE_KEY, Width, width)
