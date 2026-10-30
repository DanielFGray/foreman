// The Send keys sheet: any key hc can send, with any modifiers, shown before
// it goes; and the editor of the soft-key row, which each browser keeps for
// itself. A browser that never changed its row, or restored it, keeps no row,
// so it gets the defaults of later versions.
import { Array, Option, Result, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import { ForgetSoftKeys, PressKeys, SaveSoftKeys } from "./commands.ts"
import { characterKey, DEFAULT_SOFT_KEYS, F_KEYS, keyLabel, NAMED_KEYS, NO_SHEET_MODIFIERS, SheetModifier, type SheetModifiers, type SoftKey } from "./keys.ts"
import { KeyGroup, KeySheet, Message, type Model, type UpdateReturn } from "./model.ts"
import { maybeFocus } from "./selection.ts"

/** The row the page shows: the browser's own, or the default one. */
export const softKeysOf = (model: Model): ReadonlyArray<SoftKey> => Option.getOrElse(model.softKeys, () => DEFAULT_SOFT_KEYS)

export const CHOOSING_START = KeySheet.Choosing({ group: "Common", named: "esc", typed: "", modifiers: NO_SHEET_MODIFIERS })

/** The chosen key's hc name, or why there is none: only a typed character can be wrong. */
export const chosenKey = (sheet: Readonly<{ group: KeyGroup; named: string; typed: string; modifiers: SheetModifiers }>): Result.Result<string, string> =>
  Result.map(sheet.group === "Character" ? characterKey(sheet.typed) : Result.succeed(sheet.named), (base) =>
    [...Array.filter(SheetModifier.literals, (modifier) => sheet.modifiers[modifier]), base].join("+"),
  )

export const withSheet = (model: Model, change: (sheet: KeySheet) => KeySheet): Model => modifyFields(model, { keySheet: change })

/** Changes the sheet while a key is being chosen; nothing otherwise. */
export const choosing = (model: Model, change: (sheet: KeySheet & { _tag: "Choosing" }) => KeySheet): Model =>
  withSheet(model, (sheet) => (sheet._tag === "Choosing" ? change(sheet) : sheet))

/** Presses the chosen key in the focused pane; the sheet stays open for the next one. */
export const sentSheetKey = (model: Model): UpdateReturn =>
  Option.match(Option.all([maybeFocus(model), chosenOf(model)]), {
    onNone: () => ({ model }),
    onSome: ([address, key]) => ({ model, commands: [PressKeys({ address, keys: [key] })] }),
  })

/** Adds the chosen key to the end of the row. */
export const pinnedSheetKey = (model: Model): UpdateReturn =>
  Option.match(chosenOf(model), {
    onNone: () => ({ model }),
    onSome: (key) => changedRow(model, (row) => Array.append(row, { _tag: "Press", key })),
  })

/** Moves a key one place earlier (-1) or later (1); nothing at either end. */
export const movedSoftKey = (model: Model, index: number, by: -1 | 1): UpdateReturn =>
  Option.match(Option.all([Array.get(softKeysOf(model), index), Array.get(softKeysOf(model), index + by)]), {
    onNone: () => ({ model }),
    onSome: ([moving, other]) => changedRow(model, (row) => Array.map(row, (key, at) => (at === index ? other : at === index + by ? moving : key))),
  })

export const removedSoftKey = (model: Model, index: number): UpdateReturn => changedRow(model, (row) => Array.filter(row, (_, at) => at !== index))

/** Back to the default row, and the browser forgets its own. */
export const restoredSoftKeys = (model: Model): UpdateReturn => ({ model: modifyFields(model, { softKeys: () => Option.none() }), commands: [ForgetSoftKeys({})] })

/** The sheet over the soft keys: the key chooser, or the row's editor. */
export const keySheetView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  KeySheet.match(model.keySheet, {
    Closed: () => [],
    Choosing: (sheet) => [sheetFrame("Send keys", [chooserView(sheet, Option.isSome(maybeFocus(model)), h)], h)],
    Editing: () => [sheetFrame("Edit the soft keys", [editorView(softKeysOf(model), h)], h)],
  })

const chosenOf = (model: Model) => (model.keySheet._tag === "Choosing" ? Result.getSuccess(chosenKey(model.keySheet)) : Option.none())

const changedRow = (model: Model, change: (row: ReadonlyArray<SoftKey>) => ReadonlyArray<SoftKey>): UpdateReturn => {
  const row = change(softKeysOf(model))
  return { model: modifyFields(model, { softKeys: () => Option.some(row) }), commands: [SaveSoftKeys({ softKeys: row })] }
}

const sheetFrame = (title: string, body: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("key-sheet"), h.Role("dialog"), h.AriaLabel(title)],
    [
      h.div(
        [h.Class("key-sheet-head")],
        [
          h.h2([], [title]),
          h.button([h.Type("button"), h.Class("chip"), h.AriaLabel("close the sheet"), h.OnClick(Message.ClosedKeySheet())], ["×"]),
        ],
      ),
      ...body,
    ],
  )

const chooserView = (sheet: KeySheet & { _tag: "Choosing" }, hasPane: boolean, h: HtmlBuilder<Message>): Html => {
  const chosen = chosenKey(sheet)
  const toggle = (label: string, isOn: boolean, message: Message, name = label) =>
    h.button([h.Type("button"), h.Class(isOn ? "chip on" : "chip"), h.AriaPressed(isOn ? "true" : "false"), h.AriaLabel(name), h.OnClick(message)], [label])
  return h.div(
    [h.Class("key-chooser")],
    [
      h.div(
        [h.Class("key-row"), h.AriaLabel("modifiers")],
        Array.map(SheetModifier.literals, (modifier) => toggle(String.capitalize(modifier), sheet.modifiers[modifier], Message.ToggledSheetModifier({ modifier }), `with ${modifier}`)),
      ),
      ...(sheet.modifiers.super ? [h.p([h.Class("note")], ["Super reaches only programs that turn on the terminal's enhanced keyboard mode; an ordinary shell may get nothing."])] : []),
      h.div([h.Class("key-row"), h.AriaLabel("key groups")], Array.map(KeyGroup.literals, (group) => toggle(group, sheet.group === group, Message.PickedKeyGroup({ group })))),
      sheet.group === "Character"
        ? h.label(
            [h.Class("form-field")],
            [
              h.span([], ["Character"]),
              h.input([
                h.Type("text"),
                h.Value(sheet.typed),
                h.Placeholder("one character"),
                h.Autocomplete("off"),
                h.Spellcheck(false),
                h.Attribute("autocapitalize", "off"),
                h.Attribute("maxlength", "1"),
                h.OnInput((text) => Message.TypedSheetCharacter({ text })),
              ]),
            ],
          )
        : h.div(
            [h.Class("key-row key-grid")],
            Array.map(sheet.group === "Common" ? NAMED_KEYS : Array.map(F_KEYS, (name) => [name, name.toUpperCase()] as const), ([name, label]) =>
              toggle(label, sheet.named === name, Message.PickedSheetKey({ key: name }), `key ${name}`),
            ),
          ),
      h.div(
        [h.Class("key-sheet-foot")],
        [
          h.output([h.Class("key-preview"), h.AriaLabel("the key to send")], [Result.match(chosen, { onSuccess: keyLabel, onFailure: (reason) => reason })]),
          h.button([h.Type("button"), h.Class("chip"), h.Disabled(Result.isFailure(chosen)), h.OnClick(Message.ClickedPinSheetKey())], ["Pin"]),
          h.button([h.Type("button"), h.Class("chip"), h.Disabled(Result.isFailure(chosen) || !hasPane), h.OnClick(Message.ClickedSendSheetKey())], ["Send"]),
          h.button([h.Type("button"), h.Class("chip"), h.OnClick(Message.ClickedEditSoftKeys())], ["Edit the row"]),
        ],
      ),
    ],
  )
}

const editorView = (row: ReadonlyArray<SoftKey>, h: HtmlBuilder<Message>): Html => {
  const button = (label: string, name: string, message: Message, isDisabled = false) =>
    h.button([h.Type("button"), h.Class("chip"), h.AriaLabel(name), h.Disabled(isDisabled), h.OnClick(message)], [label])
  return h.div(
    [h.Class("key-editor")],
    [
      h.ol(
        [h.Class("key-list"), h.AriaLabel("soft keys")],
        Array.map(row, (softKey, index) => {
          const name = softKey._tag === "Press" ? softKey.key : `${softKey.modifier} (held for the next key)`
          return h.li(
            [],
            [
              h.span([h.Class("key-name")], [softKey._tag === "Press" ? keyLabel(softKey.key) : name]),
              button("↑", `move ${name} earlier`, Message.MovedSoftKey({ index, by: -1 }), index === 0),
              button("↓", `move ${name} later`, Message.MovedSoftKey({ index, by: 1 }), index === row.length - 1),
              button("Remove", `remove ${name}`, Message.RemovedSoftKey({ index })),
            ],
          )
        }),
      ),
      h.div(
        [h.Class("key-sheet-foot")],
        [
          h.button([h.Type("button"), h.Class("chip"), h.OnClick(Message.ClickedRestoreSoftKeys())], ["Restore defaults"]),
          h.button([h.Type("button"), h.Class("chip"), h.OnClick(Message.ClickedSendKeys())], ["Done"]),
        ],
      ),
    ],
  )
}
