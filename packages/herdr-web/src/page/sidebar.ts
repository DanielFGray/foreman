// The sidebar: every machine's spaces and agents, the space drag, the
// resize edge, and the New space and Settings rows.
import { Array, HashMap, Option, Record, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Fleet, SpaceGit } from "../shared/Fleet.ts"
import { agentsIn, byState, type Children, dropSide, type DropSide, type ListedAgent, listedAgents, type MachineRow, sidebarOf, type SpaceRow, spaceBadge, terminalLabel, terminalNote } from "./group.ts"
import { Bot, FolderPlus, icon, Monitor, Server, Settings as SettingsIcon } from "./icons.ts"
import { programOf } from "./programs.ts"
import { Message, type Model, SpaceDrag } from "./model.ts"
import { lastFleet, maybeFocus, selectedTab } from "./selection.ts"
import { DEFAULT_SIDEBAR_WIDTH, keyedSidebarWidth, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "./sidebarWidth.ts"
import { stateHeading, stateOf, statusDot, timeInState } from "./status.ts"

/** The sidebar: the page's name, every machine's spaces and agents, and the New space and Settings rows. */
export const sidebarView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [
      h.Class(`fleet${model.isFleetFolded ? " folded" : ""}${model.spaceDrag._tag === "Pressed" ? " dragging" : ""}`),
      // A row's own release comes first; this one ends a press let go anywhere else.
      h.OnPointerUp(() => whilePressed(model, Message.DroppedSpaceDrag())),
      h.OnPointerLeave(() => whilePressed(model, Message.DroppedSpaceDrag())),
    ],
    [
      h.div([h.Class("fleet-top")], [h.h1([], ["herdr-web"])]),
      h.div([h.Class("fleet-list")], fleetView(model, h)),
      h.div([h.Class("fleet-foot")], [newSpaceButton(model, h), settingsButton(model, h)]),
    ],
  )

export const shownSidebarWidth = (model: Model) => Option.getOrElse(model.sidebarWidth, () => DEFAULT_SIDEBAR_WIDTH)

/** The sidebar's right edge on a desk: drag it or use the arrow keys to resize, double-click for the default width. */
export const sidebarEdgeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(Option.isSome(model.sidebarGrip) ? "fleet-edge held" : "fleet-edge"),
      h.Role("separator"),
      h.Tabindex(0),
      h.AriaOrientation("vertical"),
      h.AriaLabel("resize the sidebar"),
      h.AriaValuemin(MIN_SIDEBAR_WIDTH),
      h.AriaValuemax(MAX_SIDEBAR_WIDTH),
      h.AriaValuenow(shownSidebarWidth(model)),
      h.Title("drag to resize, double-click for the default width"),
      h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX) =>
        pointerType !== "touch" && button === 0 ? Option.some(Message.PressedSidebarEdge({ x: clientX })) : Option.none(),
      ),
      h.OnDoubleClick(Message.ResetSidebarWidth()),
      // The arrow keys would otherwise scroll the page as well.
      h.OnKeyDownPreventDefault((key) => Option.as(keyedSidebarWidth(shownSidebarWidth(model), key), Message.KeyedSidebarEdge({ key }))),
    ],
    [],
  )

const newSpaceButton = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class(model.selection._tag === "NewSpace" ? "row settings-row on" : "row settings-row"),
      h.AriaCurrent(model.selection._tag === "NewSpace" ? "page" : "false"),
      h.OnClick(Message.ClickedNewSpace()),
    ],
    [icon(FolderPlus, h), h.span([h.Class("name")], ["New space"])],
  )

const settingsButton = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class(model.selection._tag === "Settings" ? "row settings-row on" : "row settings-row"),
      h.AriaCurrent(model.selection._tag === "Settings" ? "page" : "false"),
      h.OnClick(Message.ClickedSettings()),
    ],
    [icon(SettingsIcon, h), h.span([h.Class("name")], ["Settings"])],
  )

const fleetView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(lastFleet(model.bridge), {
    onNone: () => [h.p([h.Class("note")], ["Waiting for the bridge."])],
    onSome: (fleet) => {
      const { machines, loose, children } = sidebarOf(fleet)
      const openTab = Option.map(selectedTab(model), ({ tab }) => tab.id)
      // With one machine, a heading would only repeat its name.
      const isHeaded = machines.length > 1
      const isNested = model.settings.agents === "nested"
      // Nested, a space lists its own agents, and this list keeps the ones no space holds.
      const [listTitle, listed] = isNested
        ? ["Other agents", Array.map(loose, (terminal): ListedAgent => ({ terminal, space: Option.none() }))]
        : ["Agents", listedAgents({ machines, loose })]
      return !isHeaded && Array.every(machines, ({ spaces }) => Array.isReadonlyArrayEmpty(spaces)) && Array.isReadonlyArrayEmpty(listed)
        ? [h.p([h.Class("note")], ["No spaces."])]
        : [
            ...(model.spaceDrag._tag === "Refused" ? [h.p([h.Class("note error")], [`The space did not move: ${model.spaceDrag.reason}`])] : []),
            ...Array.map(machines, (row) => machineView(row, isHeaded, isNested, openTab, fleet, children, model, h)),
            ...(Array.isReadonlyArrayNonEmpty(listed)
              ? [
                  h.keyed("section")(
                    "agents",
                    [h.Class("agent-list"), h.AriaLabel(listTitle)],
                    [
                      h.h2([h.Class("list-head")], [h.span([h.Class("name")], [listTitle])]),
                      // Below the spaces, the agents sit in groups by state; "Other agents" under nested spaces has few enough to stay flat.
                      ...(isNested
                        ? [h.ul([], Array.map(listed, (agent) => agentRowView(agent, children, model, h)))]
                        : Array.flatMap(byState(listed), ({ state, agents }) => [
                            h.h3([h.Class("state-head")], [stateHeading[state]]),
                            h.keyed("ul")(`agents/${state}`, [], Array.map(agents, (agent) => agentRowView(agent, children, model, h))),
                          ])),
                    ],
                  ),
                ]
              : []),
          ]
    },
  })

const machineView = (
  { machine, spaces }: MachineRow,
  isHeaded: boolean,
  isNested: boolean,
  openTab: Option.Option<string>,
  fleet: Fleet,
  children: Children,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    machine.name,
    [h.Class("machine")],
    [
      ...(isHeaded
        ? [
            h.h2(
              [h.Class(`machine-head ${machine.state}`)],
              [
                icon(machine.isLocal ? Monitor : Server, h),
                h.span([h.Class("name")], [machine.name]),
                ...(machine.state === "connected" ? [] : [h.span([h.Class("msg")], [String.replaceAll("_", " ")(machine.state)])]),
              ],
            ),
          ]
        : []),
      ...Array.flatMap(spaces, (row, index) => [
        spaceView(row, spaceBadge(row.label, index), Record.get(fleet.git, row.space.id), openTab, dragMark(model.spaceDrag, fleet, row.space.id), h),
        ...(isNested && Array.isReadonlyArrayNonEmpty(agentsIn(row))
          ? [h.keyed("ul")(`${row.space.id}/agents`, [h.Class("space-agents")], Array.map(agentsIn(row), (terminal) => agentRowView({ terminal, space: Option.none() }, children, model, h)))]
          : []),
      ]),
    ],
  )

/** How a space row shows the drag: the pressed row, the row it would land beside, or neither. */
type DragMark = "pressed" | `drop-${DropSide}` | "none"

const dragMark = (drag: SpaceDrag, fleet: Fleet, row: string): DragMark =>
  SpaceDrag.match<DragMark>(drag, {
    Idle: () => "none",
    Pressed: ({ space, over }) =>
      space === row
        ? "pressed"
        : Option.contains(over, row)
          ? Option.match(dropSide(fleet, space, row), { onNone: () => "none", onSome: (side): DragMark => `drop-${side}` })
          : "none",
    Moving: () => "none",
    Refused: () => "none",
  })

const whilePressed = (model: Model, message: Message) => (model.spaceDrag._tag === "Pressed" ? Option.some(message) : Option.none())

// A space opens on its first tab; the tab bar then moves between its tabs. A
// mouse drags it to another place among its machine's spaces; a touch
// scrolls the sidebar instead.
const spaceView = (
  { space, label, status, tabs }: SpaceRow,
  badge: string,
  git: Option.Option<SpaceGit>,
  openTab: Option.Option<string>,
  mark: DragMark,
  h: HtmlBuilder<Message>,
): Html => {
  const isOpen = Array.some(tabs, ({ tab }) => Option.contains(openTab, tab.id))
  return h.keyed("button")(
    space.id,
    [
      h.Type("button"),
      h.Class(`row space-row${isOpen ? " on" : ""}${mark === "none" ? "" : ` ${mark}`}`),
      h.AriaCurrent(isOpen ? "page" : "false"),
      h.Disabled(Array.isReadonlyArrayEmpty(tabs)),
      ...Option.toArray(Option.map(Array.head(tabs), ({ tab }) => h.OnClick(Message.ClickedTab({ tabId: tab.id })))),
      h.OnPointerDown((pointerType, button) =>
        pointerType === "mouse" && button === 0 ? Option.some(Message.PressedSpace({ space: space.id })) : Option.none(),
      ),
      h.OnMouseEnter(Message.EnteredSpace({ space: space.id })),
      h.OnPointerUp(() => Option.some(Message.ReleasedSpace({ space: space.id }))),
    ],
    [
      // The badge takes the colour of the space's most urgent agent. The row's name already says which space it is.
      h.span([h.Class(`badge ${Option.getOrElse(status, () => "none")}`), h.Title(Option.getOrElse(status, () => "no agents")), h.AriaHidden(true)], [badge]),
      h.span([h.Class("name")], [label]),
      ...Option.toArray(Option.map(git, (state) => gitView(state, h))),
    ],
  )
}

// The branch gives way to the space's name; a dot after it marks a dirty tree.
const gitView = ({ branch, changed }: SpaceGit, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class("git")],
    [
      ...Option.toArray(Option.map(branch, (name) => h.span([h.Class("branch"), h.Title(name)], [name]))),
      ...(changed ? [h.span([h.Class("changes"), h.Title("uncommitted changes")], [])] : []),
    ],
  )

// "space · what it is doing", then how long it has been so. Under its own
// space, an agent is named by its program instead, as the space is above it.
// The agents it started follow, one level in.
const agentRowView = ({ terminal, space }: ListedAgent, children: Children, model: Model, h: HtmlBuilder<Message>): Html => {
  const started = Option.getOrElse(HashMap.get(children, terminal.address), () => [])
  return h.keyed("li")(
    terminal.address,
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(Option.contains(maybeFocus(model), terminal.address) ? "row agent-row on" : "row agent-row"),
          h.OnClick(Message.ClickedTerminal({ address: terminal.address })),
        ],
        [
          icon(Option.match(programOf(terminal), { onNone: () => Bot, onSome: (program) => program.icon }), h),
          h.span([h.Class("name")], [Option.getOrElse(space, () => terminalLabel(terminal))]),
          h.span([h.Class("msg")], [`${Option.isSome(space) ? "· " : ""}${terminalNote(terminal)}`]),
          ...Option.toArray(Option.map(timeInState(terminal, model.now), (time) => h.span([h.Class("time")], [time]))),
          statusDot(stateOf(terminal), h),
        ],
      ),
      ...(Array.isReadonlyArrayNonEmpty(started)
        ? [h.ul([h.Class("agent-children")], Array.map(started, (child) => agentRowView({ terminal: child, space: Option.none() }, children, model, h)))]
        : []),
    ],
  )
}
