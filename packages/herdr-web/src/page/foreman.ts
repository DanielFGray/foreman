// The Foreman column: foreman's fleet as the bridge last read it, beside the
// selected space, the queue as foreman ranks it for that space's project, the
// policy that says what the fleet may do by itself, and each row's one-shot
// commands as buttons. The page keeps nothing of foreman's: every button runs a
// foreman command through the bridge, and the reading that follows shows what
// it did.
import { Array, Option, Record, Result, Schema as S } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import {
  argvOf,
  DESTRUCTIVE_ACTIONS,
  FOREMAN_STEPS,
  FOREMAN_STEP_MODES,
  ForemanAction,
  type ForemanCommand,
  type ForemanDispatcher,
  type ForemanPolicy,
  type ForemanReading,
  type ForemanRow,
  type ForemanState,
  type ForemanView,
  launchableRungs,
} from "../shared/Foreman.ts"
import { ListRungs, LoadForemanEpic, RunForeman, SaveOpenEpics } from "./commands.ts"
import { type EpicRecord, ForemanQueue, type ForemanPage, Message, type Model, PipelineView, RungList, type UpdateReturn } from "./model.ts"
import { pipelineSectionView } from "./pipelineView.ts"
import { lastFleet, selectedTab } from "./selection.ts"
import { ago } from "./usage.ts"

/** The queue runs to hundreds of tasks and landed is history, so both start folded to their heading. */
export const EMPTY_FOREMAN_PAGE: ForemanPage = {
  rungs: RungList.Loading(),
  launching: Option.none(),
  armed: Option.none(),
  busy: [],
  refusal: Option.none(),
  shown: false,
  all: false,
  folded: ["queue", "landed"],
  openEpics: [],
  closedPanels: [],
  epicRecords: {},
  queue: ForemanQueue.Unread(),
  pipeline: PipelineView.Closed(),
}

/**
 * Shows or hides the column. Showing it reads the ladder's rungs again, and
 * folds the sidebar, as the other rows that open a page do; the page's own
 * choices stay.
 */
export const toggledColumn = (model: Model): UpdateReturn => {
  const shown = !model.foremanPage.shown
  if (!shown) return { model: withPage(model, (page) => ({ ...page, shown })) }
  return {
    model: withPage(modifyFields(model, { isFleetFolded: () => true }), (page) => ({ ...page, shown, rungs: RungList.Loading() })),
    commands: [ListRungs(), ...Array.map(model.foremanPage.openEpics, (key) => LoadForemanEpic({ key }))],
  }
}

/** The project of the space the selected tab is in: none when no space holds it, or when git says it is in no project. */
export const selectedProject = (model: Model): Option.Option<string> =>
  Option.flatMap(selectedTab(model), ({ space }) =>
    Option.flatMap(lastFleet(model.bridge), (fleet) => Option.flatMap(Record.get(fleet.git, space.id), (git) => git.project)),
  )

/**
 * Where the queue is read from: none while the column is hidden or the space is
 * in no project, every open project for `all`, else the selected space's project.
 * Foreman reads no project as every open one, so no read is the only way to show none.
 */
export const queueScopeOf = (model: Model): Option.Option<Option.Option<string>> => {
  if (!model.foremanPage.shown) return Option.none()
  if (model.foremanPage.all) return Option.some(Option.none())
  return Option.map(selectedProject(model), (project) => Option.some(project))
}

/**
 * The rows the column shows: all of them for `all`, else the rows of the selected
 * space's project and the fleet's own rows, which have no project. A row of
 * another project never shows, even in a read that has not caught up with a switch.
 */
export const visibleRows = (model: Model, rows: ReadonlyArray<ForemanRow>): ReadonlyArray<ForemanRow> => {
  if (model.foremanPage.all) return rows
  const project = selectedProject(model)
  return Array.filter(rows, (row) => Option.match(row.project, { onNone: () => true, onSome: (own) => Option.contains(project, own) }))
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

/**
 * Expands or collapses one epic, in every space and project filter, and keeps
 * the choice. Expanding reads the epic's description again, since it may have
 * changed while the epic was collapsed.
 */
export const toggledEpic = (model: Model, key: string): UpdateReturn => {
  const isOpen = Array.contains(model.foremanPage.openEpics, key)
  const openEpics = isOpen ? Array.filter(model.foremanPage.openEpics, (other) => other !== key) : [...model.foremanPage.openEpics, key]
  return {
    model: withPage(model, (page) => ({ ...page, openEpics, epicRecords: Record.remove(page.epicRecords, key) })),
    commands: [SaveOpenEpics({ openEpics }), ...(isOpen ? [] : [LoadForemanEpic({ key })])],
  }
}

/** Keeps what foreman said of an epic, unless it was collapsed while the read ran. */
export const recordedEpic = (model: Model, key: string, record: EpicRecord): Model =>
  withPage(model, (page) => (Array.contains(page.openEpics, key) ? { ...page, epicRecords: { ...page.epicRecords, [key]: record } } : page))

/** The column beside the workspace, when it is on show: a heading that says what the dispatcher is doing, the policy, and the rows of the scope by section. */
export const foremanColumnView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const page = model.foremanPage
  if (!page.shown) return []
  return [
    h.aside(
      [h.Class("foreman foreman-column"), h.AriaLabel("Foreman")],
      Option.match(model.foreman, {
        onNone: () => [h.h2([], ["Foreman"]), h.p([h.Class("note")], ["Asking the bridge…"])],
        onSome: (state) => [
          headingView(state, model.now, h),
          scopeView(model, h),
          pipelineSectionView(model, selectedProject(model), h),
          ...Option.match(failureOf(state), { onNone: () => [], onSome: (detail) => [h.p([h.Class("note error")], [`The dispatcher failed and starts again shortly: ${detail}`])] }),
          ...Option.match(state.problem, { onNone: () => [], onSome: (problem) => [h.p([h.Class("note error")], [problem])] }),
          ...Option.match(page.refusal, { onNone: () => [], onSome: (refusal) => [h.p([h.Class("note error"), h.Role("alert")], [refusal])] }),
          ...(Option.isSome(queueScopeOf(model))
            ? ForemanQueue.match(page.queue, {
                Unread: () => [],
                Listed: () => [],
                Unlisted: ({ reason }) => [h.p([h.Class("note error")], [reason])],
              })
            : []),
          ...Option.match(state.reading, {
            onNone: () => [h.p([h.Class("note")], ["Waiting for the dispatcher's first reading…"])],
            onSome: (reading) => [policyView(reading, page, h), ...sectionsView(visibleRows(model, [...reading.rows, ...queueRows(page.queue)]), page, h)],
          }),
        ],
      }),
    ),
  ]
}

/** Says which rows show: every project's, or the selected space's project, with the fleet's own rows. */
const scopeView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { all } = model.foremanPage
  const name = all ? "all projects" : Option.match(selectedProject(model), { onNone: () => "no project", onSome: (project) => project })
  return h.div(
    [h.Class("foreman-scope")],
    [
      h.button(
        [h.Type("button"), h.Class(all ? "chip on" : "chip"), h.AriaPressed(all ? "true" : "false"), h.OnClick(Message.ToggledForemanAll())],
        ["All projects"],
      ),
      h.span([h.Class("note"), h.AriaLabel("showing")], [name]),
    ],
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

// Older than this, the last reading is no longer the dispatcher working: it is
// stuck inside a tick.
const STALE_MS = 120_000

/**
 * What the heading says the dispatcher is doing: its own state, or stale when
 * a running one has not read the world for too long. Failed wins over stale,
 * since it says why.
 */
export const dispatcherStateOf = (reading: ForemanReading, now: number): ForemanDispatcher["state"] | "stale" =>
  reading.dispatcher.state === "failed" || Option.exists(reading.observedAt, (at) => now - Date.parse(at) < STALE_MS)
    ? reading.dispatcher.state
    : "stale"

const failureOf = (state: ForemanState) =>
  Option.flatMap(state.reading, ({ dispatcher }) => (dispatcher.state === "failed" ? Option.some(dispatcher.detail) : Option.none()))

const lineOf = (command: ForemanCommand) => argvOf(command).join(" ")

const isDestructive = (command: ForemanCommand) => command._tag === "Act" && Array.contains(DESTRUCTIVE_ACTIONS, command.action)

const headingView = (state: ForemanState, now: number, h: HtmlBuilder<Message>): Html => {
  const dispatcher = Option.map(state.reading, (reading) => dispatcherStateOf(reading, now))
  const read = Option.flatMap(state.reading, ({ observedAt }) => observedAt)
  return h.div(
    [h.Class("foreman-heading")],
    [
      h.h2([], ["Foreman"]),
      ...Option.match(dispatcher, { onNone: () => [], onSome: (shown) => [h.span([h.Class(`foreman-badge ${shown}`)], [shown])] }),
      h.span([h.Class("note")], [Option.match(read, { onNone: () => "", onSome: (at) => `Read ${ago(Date.parse(at), now)} ago` })]),
      h.button([h.Type("button"), h.Class("chip"), h.AriaLabel("read the fleet again"), h.OnClick(Message.ClickedRefreshForeman())], ["Refresh"]),
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
            h.span(
              [h.Class("foreman-step")],
              [
                h.span([], [step]),
                ...Array.map(FOREMAN_STEP_MODES, (mode) =>
                  commandButton(mode, `${mode} ${step} for every task`, { _tag: "SetStep", step, setting: mode }, page, h, policy.default[step] === mode),
                ),
              ],
            ),
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

// The rows arrive already scoped by `visibleRows`.
const sectionsView = (rows: ReadonlyArray<ForemanRow>, page: ForemanPage, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const sections = Array.filterMap(SECTIONS, ([view, title]) => {
    const mine = Array.filter(rows, (row) => row.view === view)
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
  const isOpen = Array.contains(page.openEpics, row.key)
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
      h.div(
        [h.Class("foreman-row-head")],
        [
          ...(row.epic ? [epicToggle(row.key, isOpen, h)] : []),
          h.span([h.Class("foreman-key")], [row.key]),
          h.span([h.Class("foreman-label")], [row.label]),
          ...(row.epic && !isOpen ? [h.span([h.Class("note foreman-count")], [children.length === 1 ? "1 subtask" : `${children.length} subtasks`])] : []),
        ],
      ),
      ...(row.epic && isOpen ? [epicBodyView(page.epicRecords[row.key], h)] : []),
      ...Option.match(row.detail, { onNone: () => [], onSome: (detail) => [h.div([h.Class("foreman-detail"), h.Title(detail)], [detail])] }),
      ...(Array.isReadonlyArrayNonEmpty(buttons) ? [h.div([h.Class("foreman-actions")], buttons)] : []),
      ...(isLaunching ? [rungsView(row.key, page, h)] : []),
      ...(isOpen && Array.isReadonlyArrayNonEmpty(children)
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
      Listed: ({ rungs }) => Array.map(launchableRungs(rungs), (rung) => commandButton(rung, `launch ${key} on ${rung}`, { _tag: "Launch", key, rung }, page, h)),
    }),
  )

/** The control that leads an epic row: "+" while it is collapsed, "−" while it is expanded. */
const epicToggle = (key: string, isOpen: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [h.Type("button"), h.Class("chip foreman-epic-toggle"), h.AriaExpanded(isOpen), h.AriaLabel(`${isOpen ? "collapse" : "expand"} ${key}`), h.OnClick(Message.ToggledForemanEpic({ key }))],
    [isOpen ? "−" : "+"],
  )

/** An expanded epic's description, or what stands in its place while it is read or when it could not be. */
const epicBodyView = (record: EpicRecord | undefined, h: HtmlBuilder<Message>): Html =>
  record === undefined
    ? h.p([h.Class("note")], ["Reading the epic…"])
    : record._tag === "Unread"
      ? h.p([h.Class("note error")], [record.reason])
      : h.p([h.Class("foreman-description")], [Option.getOrElse(record.description, () => "No description.")])
