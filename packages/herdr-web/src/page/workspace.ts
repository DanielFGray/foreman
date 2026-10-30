// The workspace beside the sidebar: the row of tabs over it, then what the
// selection shows: a tab's panes, a lone agent, or the settings.
import { Array, Match, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Layout, StatusState } from "../shared/Fleet.ts"
import { spaceRowOf, type SpaceRow } from "./group.ts"
import { icon, type IconNode, PanelLeft, Plus, X } from "./icons.ts"
import { Bridge, Message, type Model, PaneAction, Selection } from "./model.ts"
import { flexOf, keysView, paneActionView, paneView } from "./pane.ts"
import { labelAt, lastFleet, maybeFocus, selectedTab, shownTerminals } from "./selection.ts"
import { settingsView } from "./settingsView.ts"
import { spaceFormView, spaceHeadView } from "./spaces.ts"
import { worktreesView } from "./worktrees.ts"
import { statusMark } from "./status.ts"

/**
 * The row over the workspace: why the fleet may be out of date, then the shown
 * space's tabs. A phone puts the button that opens the sidebar drawer first,
 * and a desk hides the row when it has nothing else to show.
 */
export const topBarView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const tabs = Option.toArray(
    Option.flatMap(selectedTab(model), ({ space, tab }) =>
      Option.map(lastFleet(model.bridge), (fleet) => tabsView(spaceRowOf(fleet)(space), tab.id, model, h)),
    ),
  )
  const problem = Option.toArray(Option.map(linkProblem(model.bridge), (text) => h.span([h.Class("link-problem")], [text])))
  return h.div(
    [h.Class(Array.isReadonlyArrayEmpty(tabs) && Array.isReadonlyArrayEmpty(problem) ? "top-bar bare" : "top-bar")],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(model.isFleetFolded ? "chip icon-button fleet-toggle" : "chip icon-button fleet-toggle on"),
          h.AriaLabel("spaces"),
          h.AriaPressed(model.isFleetFolded ? "false" : "true"),
          h.OnClick(Message.ClickedFleetToggle()),
        ],
        [icon(PanelLeft, h)],
      ),
      ...problem,
      ...tabs,
    ],
  )
}

export const workspaceView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Selection.match(model.selection, {
    Settings: () => settingsView(model, h),
    NewSpace: () => spaceFormView(model, h),
    Worktrees: ({ space }) => worktreesView(space, model, h),
    Nothing: () => h.section([h.Class("workspace empty")], ["Pick a tab or an agent."]),
    Tab: () =>
      Option.match(selectedTab(model), {
        // A remembered tab waits for the fleet before it can say it is gone.
        onNone: () =>
          h.section([h.Class("workspace empty")], [Option.isSome(lastFleet(model.bridge)) ? "This tab is closed." : "Waiting for the bridge."]),
        onSome: ({ tab }) =>
          h.section(
            [h.Class("workspace")],
            [
              focusChipsView(model, h),
              ...paneActionView(model, h),
              h.div([h.Class("layout")], [layoutView(tab.root, model, h)]),
              ...keysView(model, h),
            ],
          ),
      }),
    Loose: ({ address }) =>
      h.section(
        [h.Class("workspace")],
        [h.div([h.Class("layout")], [paneView(address, Option.none(), Option.none(), model, h)]), ...keysView(model, h)],
      ),
  })

/** Why the fleet may be out of date; nothing while it is live. */
const linkProblem = (bridge: Bridge) =>
  Bridge.match(bridge, {
    Waiting: () => Option.some("connecting…"),
    Watching: ({ fleet }) => (fleet.connected ? Option.none() : Option.some("herdr-core is not reachable")),
    Lost: () => Option.some("the bridge is not reachable"),
  })

/**
 * The space's name and its rename and close buttons, then its tabs, each with its most urgent agent's dot, or a spinner while
 * that agent works, and a × that closes it; then a + that opens a new one. The
 * last tab has no ×: closing the space is the bin's job, which asks first.
 */
const tabsView = (row: SpaceRow, tabId: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const { space, tabs } = row
  const button = (text: string, title: string, message: Message) =>
    h.button([h.Type("button"), h.Class("chip"), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [text])
  const iconButton = (className: string, node: IconNode, title: string, message: Message) =>
    h.button([h.Type("button"), h.Class(className), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [icon(node, h)])
  return h.div(
    [h.Class("tabs")],
    [
      ...spaceHeadView(row, model, h),
      ...Array.map(tabs, ({ tab, label, status, program }) => {
        const isClosing = PaneAction.match(model.paneAction, {
          Idle: () => false,
          Confirming: () => false,
          ConfirmingTab: ({ tab: closing }) => closing === tab.id,
          ConfirmingSpace: () => false,
          RenamingSpace: () => false,
          Refused: () => false,
        })
        return h.keyed("span")(
          tab.id,
          [h.Class(tab.id === tabId ? "tab-item on" : "tab-item")],
          [
            h.button(
              [h.Type("button"), h.Class(tab.id === tabId ? "tab on" : "tab"), h.OnClick(Message.ClickedTab({ tabId: tab.id }))],
              [...Option.toArray(Option.map(program, ({ icon: node }) => icon(node, h))), label, ...tabMark(status, h)],
            ),
            ...(isClosing
              ? [
                  button("end it", "close the tab and end its programs", Message.ConfirmedCloseTab({ tab: tab.id })),
                  button("keep", "keep the tab", Message.ClickedKeepPane()),
                ]
              : tabs.length > 1
                ? [iconButton("tab-close", X, `close tab ${label}`, Message.ClickedCloseTab({ tab: tab.id }))]
                : []),
          ],
        )
      }),
      iconButton("tab-new", Plus, "new tab", Message.ClickedNewTab({ space: space.id })),
    ],
  )
}

/** A working agent shows a spinner where any other state shows its dot. */
const tabMark = (status: Option.Option<StatusState>, h: HtmlBuilder<Message>) =>
  Option.contains(status, "working") ? [h.span([h.Class("spinner"), h.Title("working")], [])] : statusMark(status, h)

/** On a phone the page shows only the focused pane; these chips move the focus. */
const focusChipsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const shown = shownTerminals(model)
  return h.div(
    [h.Class("focus-chips")],
    shown.length > 1
      ? Array.map(shown, (address) =>
          h.button(
            [
              h.Type("button"),
              h.Class(Option.contains(maybeFocus(model), address) ? "chip on" : "chip"),
              h.OnClick(Message.FocusedPane({ address })),
            ],
            [labelAt(model, address)],
          ),
        )
      : [],
  )
}

// A stack shows one child at a time in herdr-app; the page has no way to know
// which, so it lays a stack's children out as a column.
const layoutView = (node: Layout, model: Model, h: HtmlBuilder<Message>): Html =>
  Match.valueTags(node, {
    Block: ({ id, size, content }) =>
      Match.valueTags(content, {
        Terminal: ({ terminal }) => paneView(terminal, Option.some(id), size, model, h),
        Mod: ({ mod }) => h.keyed("div")(id, [h.Class("pane placeholder"), h.Style(flexOf(size))], [`${mod} (a herdr-app mod)`]),
        Unknown: () => h.keyed("div")(id, [h.Class("pane placeholder"), h.Style(flexOf(size))], ["a pane this page cannot show"]),
      }),
    Split: ({ id, type, size, children }) =>
      h.keyed("div")(
        id,
        [h.Class(type === "row" ? "split across" : "split down"), h.Style(flexOf(size))],
        Array.map(children, (child) => layoutView(child, model, h)),
      ),
    Unknown: ({ type }) => h.div([h.Class("pane placeholder")], [`a ${type} this page cannot show`]),
  })
