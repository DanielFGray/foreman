// The Foreman page: foreman's fleet as the bridge last read it, the queue as
// foreman ranks it, the policy that says what the fleet may do by itself, and
// each row's one-shot commands as buttons. The page keeps nothing of foreman's: every button runs a
// foreman command through the bridge, and the reading that follows shows what
// it did.
import { Array, Option, Result, Schema as S } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import {
  argvOf,
  DESTRUCTIVE_ACTIONS,
  FOREMAN_STEPS,
  ForemanAction,
  type ForemanCommand,
  type ForemanPolicy,
  type ForemanReading,
  type ForemanRow,
  type ForemanState,
  type ForemanView,
} from "../shared/Foreman.ts"
import { ListRungs, RunForeman, SaveSelection } from "./commands.ts"
import { ForemanQueue, type ForemanPage, Message, type Model, RungList, Selection, type UpdateReturn } from "./model.ts"
import { selected } from "./selection.ts"
import { ago } from "./usage.ts"

/** The queue runs to hundreds of tasks and landed is history, so both start folded to their heading. */
export const EMPTY_FOREMAN_PAGE: ForemanPage = {
  rungs: RungList.Loading(),
  launching: Option.none(),
  armed: Option.none(),
  busy: [],
  refusal: Option.none(),
  project: Option.none(),
  folded: ["queue", "landed"],
  queue: ForemanQueue.Unread(),
}

/** Opens the page and reads the ladder's rungs again; the page's own choices stay. */
export const openedForeman = (model: Model): UpdateReturn => {
  const next = selected(withPage(modifyFields(model, { isFleetFolded: () => true }), (page) => ({ ...page, rungs: RungList.Loading() })), Selection.Foreman())
  return { model: next, commands: [SaveSelection({ selection: next.selection }), ListRungs()] }
}

/**
 * A click on a command. One that ends an agent or gives up a claim only arms
 * on its first click; a command already under way is not sent twice.
 */
export const clickedForemanCommand = (model: Model, command: ForemanCommand): UpdateReturn => {
  const line = lineOf(command)
  const page = model.foremanPage
  if (Array.contains(page.busy, line)) return { model }
  if (isDestructive(command) && !Option.contains(page.armed, line)) return { model: withPage(model, (page) => ({ ...page, armed: Option.some(line) })) }
  return {
    model: withPage(model, (page) => ({ ...page, busy: [...page.busy, line], armed: Option.none(), launching: Option.none(), refusal: Option.none() })),
    commands: [RunForeman({ command })],
  }
}

export const finishedForemanCommand = (model: Model, line: string, refusal: Option.Option<string>): Model =>
  withPage(model, (page) => ({ ...page, busy: Array.filter(page.busy, (other) => other !== line), refusal: Option.orElse(refusal, () => page.refusal) }))

export const withPage = (model: Model, change: (page: ForemanPage) => ForemanPage): Model => modifyFields(model, { foremanPage: change })

export const toggledLaunch = (model: Model, key: string): Model =>
  withPage(model, (page) => ({ ...page, launching: Option.contains(page.launching, key) ? Option.none() : Option.some(key), armed: Option.none() }))

export const toggledSection = (model: Model, view: ForemanView): Model =>
  withPage(model, (page) => ({
    ...page,
    folded: Array.contains(page.folded, view) ? Array.filter(page.folded, (other) => other !== view) : [...page.folded, view],
  }))

/** The page: a heading that says whether the daemon runs, the policy, and the fleet's and the queue's rows by section. */
export const foremanView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const page = model.foremanPage
  return h.section(
    [h.Class("workspace settings foreman")],
    Option.match(model.foreman, {
      onNone: () => [h.h2([], ["Foreman"]), h.p([h.Class("note")], ["Asking the bridge…"])],
      onSome: (state) => [
        headingView(state, model.now, h),
        ...Option.match(state.problem, { onNone: () => [], onSome: (problem) => [h.p([h.Class("note error")], [problem])] }),
        ...Option.match(page.refusal, { onNone: () => [], onSome: (refusal) => [h.p([h.Class("note error"), h.Role("alert")], [refusal])] }),
        ...ForemanQueue.match(page.queue, {
          Unread: () => [],
          Listed: () => [],
          Unlisted: ({ reason }) => [h.p([h.Class("note error")], [reason])],
        }),
        ...Option.match(state.reading, {
          onNone: () => (state.isReading ? [h.p([h.Class("note")], ["Reading the fleet…"])] : []),
          onSome: (reading) => [policyView(reading, page, h), projectsView(reading, page, h), ...sectionsView([...reading.rows, ...queueRows(page.queue)], page, h)],
        }),
      ],
    }),
  )
}

const SECTIONS: ReadonlyArray<readonly [ForemanView, string]> = [
  ["attention", "Needs you"],
  ["working", "Working"],
  ["review", "Review"],
  ["queue", "Queue"],
  ["quota", "Accounts"],
  ["landed", "Landed"],
]

// Older than this, the daemon's last reading is no longer the daemon working:
// it stopped, or is stuck inside a pass.
const STALE_MS = 120_000

const lineOf = (command: ForemanCommand) => argvOf(command).join(" ")

const isDestructive = (command: ForemanCommand) => command._tag === "Act" && Array.contains(DESTRUCTIVE_ACTIONS, command.action)

const headingView = (state: ForemanState, now: number, h: HtmlBuilder<Message>): Html => {
  const isLive = Option.exists(state.daemonAt, (at) => now - at < STALE_MS)
  const isPaused = Option.exists(state.reading, ({ policy }) => policy.paused)
  const read = Option.flatMap(state.reading, ({ observedAt }) => observedAt)
  return h.div(
    [h.Class("foreman-heading")],
    [
      h.h2([], ["Foreman"]),
      h.span([h.Class(isLive ? "foreman-badge live" : "foreman-badge")], [isLive ? "daemon running" : "daemon off"]),
      ...(isPaused ? [h.span([h.Class("foreman-badge paused")], ["paused"])] : []),
      h.span([h.Class("note")], [Option.match(read, { onNone: () => "", onSome: (at) => `Read ${ago(Date.parse(at), now)} ago` })]),
      h.button(
        [h.Type("button"), h.Class("chip"), h.Disabled(state.isReading), h.AriaLabel("read the fleet again"), h.OnClick(Message.ClickedRefreshForeman())],
        [state.isReading ? "Reading…" : "Refresh"],
      ),
    ],
  )
}

/** A button that runs one command: `name…` while it runs, `name?` while it waits for its second click. */
const commandButton = (text: string, label: string, command: ForemanCommand, page: ForemanPage, h: HtmlBuilder<Message>, isOn = false): Html => {
  const line = lineOf(command)
  const isBusy = Array.contains(page.busy, line)
  const isArmed = Option.contains(page.armed, line)
  return h.button(
    [
      h.Type("button"),
      h.Class(isArmed ? "chip armed" : isOn ? "chip on" : "chip"),
      h.Title(line),
      h.AriaLabel(label),
      h.Disabled(isBusy),
      h.OnClick(Message.ClickedForemanCommand({ command })),
    ],
    [isBusy ? `${text}…` : isArmed ? `${text}?` : text],
  )
}

// Pause, the steps the fleet takes for every task, the agent limit, and each
// grant that widens the steps for one task or epic.
const policyView = ({ policy, policyError }: ForemanReading, page: ForemanPage, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("foreman-policy")],
    [
      ...Option.match(policyError, { onNone: () => [], onSome: (error) => [h.p([h.Class("note error")], [error])] }),
      h.div(
        [h.Class("foreman-controls")],
        [
          policy.paused
            ? commandButton("Resume", "resume the fleet", { _tag: "Resume" }, page, h)
            : commandButton("Pause", "pause the fleet", { _tag: "Pause" }, page, h),
          ...Array.map(FOREMAN_STEPS, (step) =>
            commandButton(step, `${policy.default[step] ? "stop" : "allow"} ${step} for every task`, { _tag: "SetStep", step, on: !policy.default[step] }, page, h, policy.default[step]),
          ),
          slotsView(policy, page, h),
        ],
      ),
      ...(Array.isReadonlyArrayNonEmpty(policy.grants)
        ? [
            h.ul(
              [h.Class("foreman-grants"), h.AriaLabel("Grants")],
              Array.map(policy.grants, (grant) =>
                h.keyed("li")(
                  grant.scope,
                  [],
                  [
                    h.span([], [`${grant.scope}: ${grant.steps.join(", ")}${grant.remaining === undefined ? "" : ` · ${grant.admitted.length} of ${grant.remaining} tasks`}`]),
                    commandButton("revoke", `revoke the grant for ${grant.scope}`, { _tag: "Revoke", scope: grant.scope }, page, h),
                  ],
                ),
              ),
            ),
          ]
        : []),
    ],
  )

const slotsView = (policy: ForemanPolicy, page: ForemanPage, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class("foreman-slots")],
    [
      ...(policy.slots > 1 ? [commandButton("−", "one agent fewer", { _tag: "SetSlots", slots: policy.slots - 1 }, page, h)] : []),
      h.span([h.Class("note")], [policy.slots === 1 ? "1 agent" : `${policy.slots} agents`]),
      commandButton("+", "one agent more", { _tag: "SetSlots", slots: policy.slots + 1 }, page, h),
    ],
  )

const projectsView = ({ projects }: ForemanReading, page: ForemanPage, h: HtmlBuilder<Message>): Html => {
  const chip = (text: string, project: Option.Option<string>) => {
    const isOn = Option.getOrNull(page.project) === Option.getOrNull(project)
    return h.button([h.Type("button"), h.Class(isOn ? "chip on" : "chip"), h.AriaPressed(isOn ? "true" : "false"), h.OnClick(Message.PickedForemanProject({ project }))], [text])
  }
  return h.div([h.Class("foreman-projects"), h.AriaLabel("Projects")], [chip("All projects", Option.none()), ...Array.map(projects, ({ name }) => chip(name, Option.some(name)))])
}

// A row with no project is the fleet's own, such as an account, and shows under every project.
const sectionsView = (rows: ReadonlyArray<ForemanRow>, page: ForemanPage, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const shown = Option.match(page.project, {
    onNone: () => rows,
    onSome: (project) => Array.filter(rows, (row) => Option.match(row.project, { onNone: () => true, onSome: (own) => own === project })),
  })
  const sections = Array.filterMap(SECTIONS, ([view, title]) => {
    const mine = Array.filter(shown, (row) => row.view === view)
    return Array.isReadonlyArrayNonEmpty(mine) ? Result.succeed(sectionView(view, title, mine, page, h)) : Result.failVoid
  })
  return Array.isReadonlyArrayNonEmpty(sections) ? sections : [h.p([h.Class("note")], ["Nothing queued, working or waiting."])]
}

const sectionView = (view: ForemanView, title: string, rows: ReadonlyArray<ForemanRow>, page: ForemanPage, h: HtmlBuilder<Message>): Html => {
  const isOpen = !Array.contains(page.folded, view)
  return h.keyed("section")(
    view,
    [h.Class(view === "attention" ? "foreman-section attention" : "foreman-section")],
    [
      h.h3(
        [],
        [
          h.button(
            [h.Type("button"), h.Class("foreman-section-toggle"), h.AriaExpanded(isOpen), h.OnClick(Message.ToggledForemanSection({ view }))],
            [title, " ", h.span([h.Class("count")], [String(rows.length)])],
          ),
        ],
      ),
      ...(isOpen ? [h.ul([h.Class("foreman-rows"), h.AriaLabel(title)], groupedRows(rows, page, h))] : []),
    ],
  )
}

const queueRows = (queue: ForemanQueue): ReadonlyArray<ForemanRow> =>
  ForemanQueue.match(queue, { Unread: () => [], Listed: ({ rows }) => rows, Unlisted: () => [] })

// Each epic row leads its own tasks, in a list nested under it. A task whose
// epic has no row in the section stays at the top level, in the given order.
const groupedRows = (rows: ReadonlyArray<ForemanRow>, page: ForemanPage, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const epics = new Set(Array.filterMap(rows, (row) => (row.epic ? Result.succeed(row.key) : Result.failVoid)))
  const underShownEpic = (row: ForemanRow) => Option.exists(row.parent, (parent) => epics.has(parent))
  return Array.filterMap(rows, (row) =>
    underShownEpic(row)
      ? Result.failVoid
      : Result.succeed(rowView(row, Array.filter(rows, (child) => Option.contains(child.parent, row.key)), page, h)),
  )
}

const rowView = (row: ForemanRow, children: ReadonlyArray<ForemanRow>, page: ForemanPage, h: HtmlBuilder<Message>): Html => {
  const isLaunching = Option.contains(page.launching, row.key)
  const actions = Array.filter(row.actions, S.is(ForemanAction))
  const buttons = [
    ...(row.view === "queue" && !row.epic
      ? [h.button([h.Type("button"), h.Class(isLaunching ? "chip on" : "chip"), h.AriaExpanded(isLaunching), h.AriaLabel(`launch ${row.key}`), h.OnClick(Message.ClickedLaunch({ key: row.key }))], ["launch"])]
      : []),
    ...(row.view === "review"
      ? Array.map(["review", "land"] as const, (step) => commandButton(`allow ${step}`, `allow ${step} for ${row.key} once`, { _tag: "Allow", key: row.key, step }, page, h))
      : []),
    ...Array.map(actions, (action) => commandButton(action, `${action} ${row.key}`, { _tag: "Act", action, key: row.key }, page, h)),
  ]
  return h.keyed("li")(
    `${row.view}/${row.key}`,
    [h.Class("foreman-row")],
    [
      h.div([h.Class("foreman-row-head")], [h.span([h.Class("foreman-key")], [row.key]), h.span([h.Class("foreman-label")], [row.label])]),
      ...Option.match(row.detail, { onNone: () => [], onSome: (detail) => [h.div([h.Class("foreman-detail"), h.Title(detail)], [detail])] }),
      ...(Array.isReadonlyArrayNonEmpty(buttons) ? [h.div([h.Class("foreman-actions")], buttons)] : []),
      ...(isLaunching ? [rungsView(row.key, page, h)] : []),
      ...(Array.isReadonlyArrayNonEmpty(children)
        ? [h.ul([h.Class("foreman-rows foreman-children"), h.AriaLabel(`tasks under ${row.key}`)], Array.map(children, (child) => rowView(child, [], page, h)))]
        : []),
    ],
  )
}

const rungsView = (key: string, page: ForemanPage, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("foreman-actions foreman-rungs"), h.AriaLabel(`rungs for ${key}`)],
    RungList.match(page.rungs, {
      Loading: () => [h.span([h.Class("note")], ["Reading the ladder…"])],
      Unlisted: ({ reason }) => [h.span([h.Class("note error")], [reason])],
      Listed: ({ rungs }) => Array.map(rungs, (rung) => commandButton(rung, `launch ${key} on ${rung}`, { _tag: "Launch", key, rung }, page, h)),
    }),
  )
