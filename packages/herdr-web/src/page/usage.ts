// The quota bar at the foot of the page: a meter per coding plan for its
// window closest to the limit, and on a tap that plan's every window, how its
// spend compares with an even one, and its other facts.
import { Array, Option, Order } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ProviderId, Reading, Usage, UsageSection, UsageWindow } from "../shared/Usage.ts"
import { ExternalLink, icon, RefreshCw } from "./icons.ts"

export type UsageMessages<M> = Readonly<{
  toggled: (provider: ProviderId) => M
  refreshed: (provider: Option.Option<ProviderId>) => M
}>

/** Nothing until a plan has numbers or an error to show. */
export const usageBarView = <M>(
  usage: Option.Option<Usage>,
  detail: Option.Option<ProviderId>,
  now: number,
  messages: UsageMessages<M>,
  h: HtmlBuilder<M>,
): ReadonlyArray<Html> => {
  const shown = Array.filter(Option.match(usage, { onNone: () => [], onSome: ({ readings }) => readings }), isShown)
  if (!Array.isReadonlyArrayNonEmpty(shown)) return []
  const open = Option.flatMap(detail, (id) => Array.findFirst(shown, (reading) => reading.id === id))
  return [
    h.footer(
      [h.Class("usage")],
      [
        ...Option.toArray(Option.map(open, (reading) => detailView(reading, now, messages, h))),
        h.div([h.Class("usage-bar")], Array.map(shown, (reading) => segmentView(reading, Option.contains(detail, reading.id), messages, h))),
      ],
    ),
  ]
}

/** The window closest to its limit; of equally used ones, the last. */
export const tightest = (windows: ReadonlyArray<UsageWindow>): Option.Option<UsageWindow> =>
  Array.reduce(windows, Option.none<UsageWindow>(), (best, window) =>
    Option.exists(best, ({ used }) => used > window.used) ? best : Option.some(window),
  )

/** "47m", "2h 53m", "4d 11h": the coarsest two units that still say when. */
export const countdown = (ms: number) => {
  const minutes = Math.ceil(Math.max(0, ms) / 60e3)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes / 60) % 24
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes % 60}m`
}

export type Severity = "normal" | "warning" | "critical"

/** Warning from 60% used, critical from 80%. */
export const severity = (used: number): Severity => (used >= 80 ? "critical" : used >= 60 ? "warning" : "normal")

export type Pace = Readonly<{ expected: number; runsOutIn: Option.Option<number> }>

/**
 * How a window's use compares with an even spend across it: the percent an
 * even spend would have used by now, and when it runs out at the rate so far
 * (none when it lasts until reset). None until a hundredth of the window has
 * passed, since an earlier estimate swings too far to help.
 */
export const pace = (window: UsageWindow, now: number): Option.Option<Pace> =>
  Option.flatMap(
    Option.zipWith(window.length, window.resetsAt, (length, resetsAt) => ({ length, left: resetsAt - now })),
    ({ length, left }) => {
      const elapsed = length - left
      return left < 0 || elapsed < length / 100
        ? Option.none()
        : Option.some({
            expected: (elapsed / length) * 100,
            runsOutIn: Option.filter(
              Option.map(Option.liftPredicate(window.used, (used) => used > 0), (used) => ((100 - used) * elapsed) / used),
              (ms) => ms < left,
            ),
          })
    },
  )

/** "11% in reserve · Lasts until reset", or "4% in deficit · Runs out in 2d 3h". */
export const describePace = ({ expected, runsOutIn }: Pace, used: number) => {
  if (used >= 100) return "Ran out"
  const margin = expected - used
  const standing = margin >= 0.5 ? `${Math.round(margin)}% in reserve` : margin <= -0.5 ? `${Math.round(-margin)}% in deficit` : "On pace"
  return `${standing} · ${Option.match(runsOutIn, { onNone: () => "Lasts until reset", onSome: (ms) => `Runs out in ${countdown(ms)}` })}`
}

// A signed-out plan, or one not read yet, takes no room in the bar.
const isShown = ({ report, error, isReading }: Reading) => Option.isSome(report) || Option.isSome(error) || isReading

const worstFirst = Order.mapInput(Order.Number, (window: UsageWindow) => -window.used)

const segmentView = <M>(reading: Reading, isOpen: boolean, messages: UsageMessages<M>, h: HtmlBuilder<M>): Html => {
  const worst = Option.flatMap(reading.report, ({ windows }) => tightest(windows))
  return h.button(
    [
      h.Type("button"),
      h.Class(isOpen ? "usage-segment on" : "usage-segment"),
      h.AriaExpanded(isOpen),
      h.AriaLabel(
        Option.match(worst, {
          onNone: () => `${reading.name} usage`,
          onSome: ({ label, used }) => `${reading.name} usage, ${label} ${Math.round(used)}% used`,
        }),
      ),
      h.OnClick(messages.toggled(reading.id)),
    ],
    [
      h.span([], [reading.name]),
      ...Option.toArray(Option.map(worst, ({ used }) => meterView(used, h))),
      ...Option.toArray(Option.map(worst, ({ used }) => h.span([h.Class("usage-percent")], [`${Math.round(used)}%`]))),
      // The numbers are the last good ones; the panel says why.
      ...(Option.isSome(reading.error) ? [h.span([h.Class("usage-error")], ["!"])] : []),
    ],
  )
}

const meterView = <M>(used: number, h: HtmlBuilder<M>): Html =>
  h.span([h.Class(`usage-meter ${severity(used)}`)], [h.span([h.Style({ width: `${used}%` })], [])])

const detailView = <M>(reading: Reading, now: number, messages: UsageMessages<M>, h: HtmlBuilder<M>): Html =>
  h.section(
    [h.Class("usage-detail"), h.AriaLabel(`${reading.name} usage`)],
    [
      h.div(
        [h.Class("usage-title")],
        [
          h.strong([], [reading.name]),
          ...Option.toArray(Option.map(Option.flatMap(reading.report, ({ plan }) => plan), (plan) => h.span([], [plan]))),
        ],
      ),
      ...Option.toArray(Option.map(reading.error, (error) => h.p([h.Class("usage-error")], [error]))),
      ...Option.match(reading.report, {
        onNone: () => [],
        onSome: ({ windows, sections }) => [
          ...Array.map(Array.sort(windows, worstFirst), (window) => windowView(window, now, h)),
          ...Array.map(sections, (section) => sectionView(section, now, h)),
        ],
      }),
      h.div(
        [h.Class("usage-actions")],
        [
          h.span(
            [h.Class("usage-updated")],
            [
              reading.isReading
                ? "Reading…"
                : Option.match(reading.updated, { onNone: () => "Not read yet", onSome: (at) => `Read ${ago(at, now)} ago` }),
            ],
          ),
          h.button(
            [h.Type("button"), h.Class("chip icon-chip"), h.OnClick(messages.refreshed(Option.some(reading.id)))],
            [icon(RefreshCw, h), "refresh"],
          ),
          h.a([h.Class("icon-chip"), h.Href(reading.dashboard), h.Target("_blank"), h.Rel("noreferrer")], ["dashboard", icon(ExternalLink, h)]),
        ],
      ),
    ],
  )

/** "Weekly 89% left", its reset, a bar of what is left with a tick where an even spend would have left it, and whether the rest lasts. */
const windowView = <M>(window: UsageWindow, now: number, h: HtmlBuilder<M>): Html => {
  const maybePace = pace(window, now)
  return h.div(
    [h.Class("usage-window")],
    [
      h.div(
        [h.Class("usage-row")],
        [
          h.span([], [`${window.label} ${100 - Math.round(window.used)}% left`]),
          ...Option.toArray(Option.map(window.resetsAt, (at) => h.span([h.Class("usage-note")], [`Resets in ${countdown(at - now)}`]))),
        ],
      ),
      h.div(
        [h.Class(`usage-left ${severity(window.used)}`)],
        [
          h.span([h.Style({ width: `${100 - window.used}%` })], []),
          ...Option.toArray(Option.map(maybePace, ({ expected }) => h.i([h.Style({ left: `${100 - expected}%` })], []))),
        ],
      ),
      ...Option.toArray(Option.map(maybePace, (p) => h.span([h.Class("usage-note")], [describePace(p, window.used)]))),
    ],
  )
}

const sectionView = <M>({ title, facts, windows }: UsageSection, now: number, h: HtmlBuilder<M>): Html =>
  h.div(
    [h.Class("usage-section")],
    [
      h.strong([], [title]),
      ...Array.map(windows, (window) => windowView(window, now, h)),
      ...Array.map(facts, ([name, value]) => h.div([h.Class("usage-row usage-note")], [h.span([], [name]), h.span([], [value])])),
    ],
  )

/** How long ago: "less than a minute", else a countdown of whole minutes. */
const ago = (at: number, now: number) => {
  const seconds = Math.floor((now - at) / 1000)
  return seconds < 60 ? "less than a minute" : countdown((seconds - (seconds % 60)) * 1000)
}
