// Making, renaming and closing herdr-app spaces from the page. A new space
// is opened from a form in place of a tab; the open space's name in the tab
// bar renames it and closes it.
import { Array, Option, Record, String } from "effect"
import type { Machine } from "../shared/Fleet.ts"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import { CloseSpace, FocusField, NewSpace, RenameSpace, SaveSelection } from "./commands.ts"
import { type SpaceRow, terminalsIn } from "./group.ts"
import { GitBranch, icon, type IconNode, Pencil, Trash2 } from "./icons.ts"
import { Message, type Model, PaneAction, Selection, type SpaceForm, type SpaceFormField, SpaceFormState, type UpdateReturn } from "./model.ts"
import { lastFleet, selected, selectedTab } from "./selection.ts"
import { stateOf } from "./status.ts"

export const EMPTY_SPACE_FORM: SpaceForm = { machine: "", folder: "", name: "", program: "", state: SpaceFormState.Editing() }

/** Opens the form in place of a tab; what was typed in it last stays. */
export const openedSpaceForm = (model: Model): UpdateReturn => {
  const next = selected(modifyFields(model, { isFleetFolded: () => true }), Selection.NewSpace())
  return { model: next, commands: [SaveSelection({ selection: next.selection }), FocusField({ id: FOLDER_ID })] }
}

export const editedSpaceForm = (model: Model, field: SpaceFormField, value: string): Model =>
  modifyFields(model, { spaceForm: (form) => ({ ...form, [field]: value, state: SpaceFormState.Editing() }) })

/** Asks the bridge for the space; a second press while one opens does nothing. */
export const submittedSpaceForm = (model: Model): UpdateReturn => {
  const { machine, folder, name, program, state } = model.spaceForm
  return state._tag === "Opening"
    ? { model }
    : {
        model: modifyFields(model, { spaceForm: (form) => ({ ...form, state: SpaceFormState.Opening() }) }),
        commands: [
          NewSpace({
            machine: Option.filter(Option.some(machine), (name) => String.isNonEmpty(name) && !isLocal(model, name)),
            folder: String.trim(folder),
            name,
            program: Option.filter(Option.some(String.trim(program)), String.isNonEmpty),
          }),
        ],
      }
}

/** The space opened: the form empties, and the page shows its tab. */
export const openedSpace = (model: Model, tab: string): Model =>
  selected(modifyFields(model, { spaceForm: () => EMPTY_SPACE_FORM }), Selection.Tab({ tabId: tab, maybeFocus: Option.none() }))

export const refusedSpace = (model: Model, reason: string): Model =>
  modifyFields(model, { spaceForm: (form) => ({ ...form, state: SpaceFormState.Refused({ reason }) }) })

/** The name field starts from the space's own name. */
export const startedRename = (model: Model, space: string): UpdateReturn => ({
  model: modifyFields(model, {
    paneAction: () => PaneAction.RenamingSpace({ space, name: Option.getOrElse(Option.map(findSpace(model, space), ({ name }) => name), () => "") }),
  }),
  commands: [FocusField({ id: RENAME_ID })],
})

export const typedSpaceName = (model: Model, name: string): Model =>
  Option.match(renaming(model.paneAction), {
    onNone: () => model,
    onSome: ({ space }) => modifyFields(model, { paneAction: () => PaneAction.RenamingSpace({ space, name }) }),
  })

export const submittedSpaceName = (model: Model): UpdateReturn =>
  Option.match(renaming(model.paneAction), {
    onNone: () => ({ model }),
    onSome: ({ space, name }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.Idle() }), commands: [RenameSpace({ space, name })] }),
  })

/** Closing a space ends every program in it, so it takes a second click; the page then shows nothing in its place. */
export const confirmedCloseSpace = (model: Model, space: string): UpdateReturn => {
  const isShown = Option.exists(selectedTab(model), (shown) => shown.space.id === space)
  const idle = modifyFields(model, { paneAction: () => PaneAction.Idle() })
  const next = isShown ? selected(idle, Selection.Nothing()) : idle
  return { model: next, commands: [CloseSpace({ space }), ...(isShown ? [SaveSelection({ selection: next.selection })] : [])] }
}

/**
 * The open space's name in the tab bar, with a pencil that renames it, a
 * branch that opens its worktrees when it is in a repository, and a bin that
 * closes it. Renaming swaps the name for a text box; Enter keeps the
 * new name and Escape the old. Closing first says what it will end.
 */
export const spaceHeadView = (row: SpaceRow, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  // The fleet has git state only for a space whose folder is in a repository.
  const isRepo = Option.exists(lastFleet(model.bridge), ({ git }) => Record.has(git, row.space.id))
  const plain = () => namedView(row, isRepo, h)
  return PaneAction.match(model.paneAction, {
    Idle: plain,
    Confirming: plain,
    ConfirmingTab: plain,
    Refused: plain,
    RenamingSpace: ({ space, name }) => (space === row.space.id ? renameView(row.label, name, h) : plain()),
    ConfirmingSpace: ({ space }) => (space === row.space.id ? confirmView(row, h) : plain()),
  })
}

/** The form that opens a space: the machine, when there is more than one, a folder, a name and a program. */
export const spaceFormView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { machine, folder, name, program, state } = model.spaceForm
  const machines = Option.getOrElse(Option.map(lastFleet(model.bridge), ({ machines }) => machines), () => [])
  const chosen = Array.findFirst(machines, (one) => (String.isEmpty(machine) ? one.isLocal : one.name === machine))
  const folders = Array.dedupe(Array.flatMap(Option.toArray(chosen), ({ spaces }) => Array.map(spaces, ({ folder }) => folder)))
  const isOpening = state._tag === "Opening"
  const field = (label: string, input: Html) => h.label([h.Class("form-field")], [h.span([], [label]), input])
  const text = (key: SpaceFormField, value: string, placeholder: string) =>
    h.input([
      h.Type("text"),
      h.Name(key),
      h.Value(value),
      h.Placeholder(placeholder),
      h.Spellcheck(false),
      h.Autocomplete("off"),
      h.OnInput((value) => Message.UpdatedSpaceForm({ field: key, value })),
    ])
  return h.section(
    [h.Class("workspace settings")],
    [
      h.h2([], ["New space"]),
      h.form(
        [h.Class("space-form"), h.OnSubmit(Message.SubmittedSpaceForm())],
        [
          ...(machines.length > 1 ? [field("Machine", machinePicker(machines, chosen, h))] : []),
          field(
            "Folder",
            h.input([
              h.Type("text"),
              h.Name("folder"),
              h.Value(folder),
              h.Placeholder("such as ~/src/project; empty: the home folder"),
              h.List(FOLDERS_ID),
              h.Id(FOLDER_ID),
              h.Spellcheck(false),
              h.Autocomplete("off"),
              h.OnInput((value) => Message.UpdatedSpaceForm({ field: "folder", value })),
            ]),
          ),
          h.datalist([h.Id(FOLDERS_ID)], Array.map(folders, (one) => h.option([h.Value(one)], []))),
          field("Name", text("name", name, "empty: named after its folder")),
          field("Program", text("program", program, "such as claude; empty: a shell")),
          h.p([h.Class("note")], ["The program runs in the space's first pane, and a shell stays when it ends."]),
          h.div(
            [h.Class("form-actions")],
            [h.button([h.Type("submit"), h.Class("chip"), h.Disabled(isOpening)], [isOpening ? "Opening…" : "Open space"])],
          ),
          ...SpaceFormState.match(state, {
            Editing: () => [],
            Opening: () => [],
            Refused: ({ reason }) => [h.p([h.Class("note error")], [`The space did not open: ${reason}`])],
          }),
        ],
      ),
    ],
  )
}

const FOLDERS_ID = "space-folders"
const FOLDER_ID = "space-folder"
const RENAME_ID = "space-new-name"

const namedView = ({ space, label }: SpaceRow, isRepo: boolean, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.span(
    [h.Class("space-head")],
    [
      h.span([h.Class("space-name")], [label]),
      iconButton(Pencil, `rename space ${label}`, Message.ClickedRenameSpace({ space: space.id }), h),
      ...(isRepo ? [iconButton(GitBranch, `worktrees of ${label}`, Message.ClickedWorktrees({ space: space.id }), h)] : []),
      iconButton(Trash2, `close space ${label}`, Message.ClickedCloseSpace({ space: space.id }), h),
    ],
  ),
]

const renameView = (label: string, name: string, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.form(
    [h.Class("space-rename"), h.OnSubmit(Message.SubmittedSpaceName())],
    [
      h.input([
        h.Type("text"),
        h.AriaLabel(`new name for ${label}`),
        h.Placeholder("empty: named after its folder"),
        h.Value(name),
        h.Id(RENAME_ID),
        h.Spellcheck(false),
        h.OnInput((name) => Message.UpdatedSpaceName({ name })),
        h.OnKeyDownPreventDefault((key) => (key === "Escape" ? Option.some(Message.ClickedKeepPane()) : Option.none())),
      ]),
    ],
  ),
]

const confirmView = ({ space, label, tabs }: SpaceRow, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const terminals = Array.flatMap(tabs, ({ tab }) => terminalsIn(tab.root))
  const working = Array.filter(Array.flatMap(tabs, ({ agents }) => agents), (agent) => Option.contains(stateOf(agent), "working"))
  return [
    h.span([h.Class("space-name")], [label]),
    h.span([h.Class("space-closing")], [closeSummary(tabs.length, terminals.length, working.length)]),
    chip("end it", "close the space and end its programs", Message.ConfirmedCloseSpace({ space: space.id }), h),
    chip("keep", "keep the space", Message.ClickedKeepPane(), h),
  ]
}

const chip = (text: string, title: string, message: Message, h: HtmlBuilder<Message>) =>
  h.button([h.Type("button"), h.Class("chip"), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [text])

const iconButton = (node: IconNode, title: string, message: Message, h: HtmlBuilder<Message>) =>
  h.button([h.Type("button"), h.Class("space-action"), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [icon(node, h)])

const closeSummary = (tabs: number, terminals: number, working: number) =>
  `Ends ${plural(tabs, "tab")} and ${plural(terminals, "terminal")}${working > 0 ? `, ${plural(working, "working agent")} among them` : ""}.`

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

const findSpace = (model: Model, space: string) =>
  Option.flatMap(lastFleet(model.bridge), ({ machines }) => Array.findFirst(Array.flatMap(machines, ({ spaces }) => spaces), ({ id }) => id === space))

const isLocal = (model: Model, machine: string) =>
  Option.exists(lastFleet(model.bridge), ({ machines }) => Array.some(machines, (one) => one.isLocal && one.name === machine))

const renaming = (action: PaneAction) => (action._tag === "RenamingSpace" ? Option.some(action) : Option.none())

/** Every machine; one hc cannot reach now shows its state and cannot be picked. */
const machinePicker = (machines: ReadonlyArray<Machine>, chosen: Option.Option<Machine>, h: HtmlBuilder<Message>): Html =>
  h.select(
    [h.Name("machine"), h.OnChange((value) => Message.UpdatedSpaceForm({ field: "machine", value }))],
    Array.map(machines, (one) =>
      h.option(
        [
          h.Value(one.isLocal ? "" : one.name),
          h.Selected(Option.exists(chosen, ({ name }) => name === one.name)),
          h.Disabled(!one.isLocal && one.state !== "connected"),
        ],
        [one.isLocal ? `${one.name} (this machine)` : one.state === "connected" ? one.name : `${one.name} (${String.replaceAll("_", " ")(one.state)})`],
      ),
    ),
  )
