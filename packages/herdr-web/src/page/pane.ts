// One pane: its head with the split, close and view buttons, its chat or
// live terminal, the chat's prompt, and the phone's soft keys.
import { Array, Match, Option, Record, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Mount from "foldkit/mount"
import { modelName } from "../shared/Chat.ts"
import type { Size } from "../shared/Fleet.ts"
import { chatView } from "./chatView.ts"
import { terminalNote } from "./group.ts"
import { programOf } from "./programs.ts"
import { Columns2, icon, type IconNode, MessageSquare, Rows2, SquareTerminal, X } from "./icons.ts"
import { KeepTypingFocus, keyLabel, modifiersAttribute } from "./keys.ts"
import { keySheetView, softKeysOf } from "./keySheet.ts"
import { Conversation, Delivery, Message, type Model, PaneAction, View, ViewName } from "./model.ts"
import { queueView, suggestion } from "./queue.ts"
import { findTerminal, isClaudeCode, labelAt, maybeFocus, viewOf } from "./selection.ts"
import { fontStack } from "./settings.ts"
import { stateOf, statusDot } from "./status.ts"
import { ownAnswerPrompt, questionView } from "./question.ts"
import { waitingAt } from "./waiting.ts"
import { LiveTerminal, MODIFIERS_ATTRIBUTE } from "./terminal.ts"

/** A terminal's pane; `maybePane` is its herdr-app pane, which the split and close buttons act on. */
export const paneView = (
  address: string,
  maybePane: Option.Option<string>,
  size: Option.Option<Size>,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeTerminal = findTerminal(model, address)
  const shown = viewOf(model, address)
  const isFocused = Option.contains(maybeFocus(model), address)
  return h.keyed("section")(
    address,
    [h.Class(Option.contains(maybeFocus(model), address) ? "pane focused" : "pane"), h.Style(flexOf(size))],
    [
      h.div(
        [h.Class("pane-head"), h.OnClick(Message.FocusedPane({ address }))],
        [
          ...Option.match(maybeTerminal, { onNone: () => [], onSome: (terminal) => [statusDot(stateOf(terminal), h)] }),
          ...Option.toArray(Option.map(Option.flatMap(maybeTerminal, programOf), ({ icon: node }) => icon(node, h))),
          h.span([h.Class("name")], [labelAt(model, address)]),
          ...modelTagView(address, model, h),
          ...Option.toArray(Option.map(maybeTerminal, (terminal) => h.span([h.Class("msg")], [terminalNote(terminal)]))),
          // Before the view chips, so they stay in place as these show and hide.
          ...Option.toArray(Option.map(maybePane, (pane) => paneButtons(pane, model, h))),
          // A question that wants typed text is answered in the terminal, so a chat can switch to it.
          ...(isClaudeCode(model, address)
            ? Array.map(ViewName.literals, (name) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(shown._tag === name ? "chip icon-chip view-chip on" : "chip icon-chip view-chip"),
                    h.AriaLabel(name === "Chat" ? "chat" : "terminal"),
                    h.AriaPressed(shown._tag === name ? "true" : "false"),
                    h.OnClick(Message.SelectedView({ address, view: name })),
                  ],
                  [icon(name === "Chat" ? MessageSquare : SquareTerminal, h), h.span([h.Class("label")], [name === "Chat" ? "chat" : "terminal"])],
                ),
              )
            : []),
        ],
      ),
      ...modelMenuView(address, model, h),
      View.match(shown, {
        // The prompt sits under the focused pane's chat; a click on another chat moves it there.
        Chat: ({ conversation }) =>
          h.div(
            [h.Class("chat-view"), h.OnClick(Message.FocusedPane({ address }))],
            [
              Conversation.match(conversation, {
                Loading: () => h.p([h.Class("chat note")], ["reading the conversation…"]),
                Shown: ({ entries }) => chatView(entries, waitingAt(model, address), questionView(model, address, h), h),
                Unreadable: ({ reason }) => h.p([h.Class("chat note error")], [reason]),
              }),
              ...(isFocused ? [...queueView(model, address, h), promptView(model, address, h)] : []),
            ],
          ),
        Terminal: ({ link }) =>
          h.div(
            [h.Class("live")],
            [
              ...Match.valueTags(link, {
                Connecting: () => [h.p([h.Class("note link-note")], ["connecting…"])],
                Live: () => [],
                Lost: ({ reason }) => [h.p([h.Class("note error link-note")], [`${reason}; trying again`])],
              }),
              // The emulator owns this element's children, so it has none here.
              // Keyed by its font, so a new font or size starts the terminal afresh.
              h.keyed("div")(
                `${address} ${fontStack("terminal", model.settings.terminal.font)} ${model.settings.terminal.size}`,
                [
                  h.Class("terminal"),
                  h.Attribute(
                    MODIFIERS_ATTRIBUTE,
                    Option.contains(maybeFocus(model), address) ? modifiersAttribute(model.modifiers) : "",
                  ),
                  h.OnMount(
                    Mount.mapMessage(
                      LiveTerminal({ address, font: model.settings.terminal.font, size: model.settings.terminal.size }),
                      (message) =>
                        Match.valueTags(message, {
                          ChangedLink: ({ link }) => Message.ChangedLink({ address, link }),
                          PointedAtLink: ({ uri }) => Message.PointedAtLink({ uri }),
                          UsedModifiers: () => Message.UsedModifiers(),
                        }),
                    ),
                  ),
                  h.OnClick(Message.FocusedPane({ address })),
                ],
                [],
              ),
            ],
          ),
      }),
      // A refused key press, said in the pane it was for.
      ...(isFocused
        ? Delivery.match(model.delivery, {
            Ready: () => [],
            Refused: ({ reason }) => [h.p([h.Class("note error")], [reason])],
          })
        : []),
    ],
  )
}

/** Why herdr-app refused the last split, new tab or close. */
export const paneActionView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  PaneAction.match(model.paneAction, {
    Idle: () => [],
    Confirming: () => [],
    ConfirmingTab: () => [],
    ConfirmingSpace: () => [],
    RenamingSpace: () => [],
    PickingModel: () => [],
    Refused: ({ reason }) => [h.p([h.Class("note error")], [reason])],
  })

/**
 * The soft keys for the focused pane, a terminal's or a chat's, with the Send
 * keys sheet over them when it is open; none when no terminal is on show.
 */
export const keysView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(maybeFocus(model), {
    onNone: () => [],
    onSome: () => [
        ...keySheetView(model, h),
        h.div(
          [h.Class("keys"), h.OnMount(Mount.mapMessage(KeepTypingFocus(), () => Message.CompletedKeepTypingFocus()))],
          [...Array.map(softKeysOf(model), (softKey) =>
            Match.valueTags(softKey, {
              Press: ({ key }) =>
                h.button([h.Type("button"), h.Class("chip"), h.AriaLabel(key), h.OnClick(Message.ClickedKey({ key }))], [keyLabel(key)]),
              Hold: ({ modifier }) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(model.modifiers[modifier] ? "chip on" : "chip"),
                    h.AriaPressed(model.modifiers[modifier] ? "true" : "false"),
                    h.OnClick(Message.ToggledModifier({ modifier })),
                  ],
                  [modifier],
                ),
            }),
          ),
          // Any other key, and the row's editor.
          h.button(
            [h.Type("button"), h.Class(model.keySheet._tag === "Closed" ? "chip" : "chip on"), h.AriaLabel("more keys"), h.OnClick(model.keySheet._tag === "Closed" ? Message.ClickedSendKeys() : Message.ClosedKeySheet())],
            ["⋯"],
          ),
          ],
        ),
      ],
  })

/** A node's flex share: its weight, or an even share when herdr-app gives none. */
export const flexOf = (size: Option.Option<Size>) => ({ flex: `${Option.getOrElse(Option.flatMap(size, ({ weight }) => weight), () => 1)} 1 0` })

/** The head shows these under the pointer or keyboard focus; a close waiting for its answer keeps them shown. */
const paneButtons = (pane: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const button = (label: string, title: string, message: Message) =>
    h.button([h.Type("button"), h.Class("chip"), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [label])
  const iconButton = (node: IconNode, title: string, message: Message) =>
    h.button([h.Type("button"), h.Class("chip icon-button"), h.Title(title), h.AriaLabel(title), h.OnClick(message)], [icon(node, h)])
  const isClosing = PaneAction.match(model.paneAction, {
    Idle: () => false,
    Confirming: ({ pane: closing }) => closing === pane,
    ConfirmingTab: () => false,
    ConfirmingSpace: () => false,
    RenamingSpace: () => false,
    PickingModel: () => false,
    Refused: () => false,
  })
  return h.span(
    [h.Class(isClosing ? "pane-actions confirming" : "pane-actions")],
    isClosing
      ? [button("end it", "close the pane and end its program", Message.ConfirmedClose({ pane })), button("keep", "keep the pane", Message.ClickedKeepPane())]
      : [
          iconButton(Columns2, "split right", Message.ClickedSplit({ pane, direction: "right" })),
          iconButton(Rows2, "split down", Message.ClickedSplit({ pane, direction: "down" })),
          iconButton(X, "close the pane", Message.ClickedClose({ pane })),
        ],
  )
}

/**
 * The focused chat's prompt: its text joins the agent's queue, and goes with
 * Enter after it when the agent can take it. An empty prompt shows what the
 * agent suggests.
 */
const promptView = (model: Model, address: string, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class("prompt"), h.OnSubmit(Message.SubmittedPrompt())],
    [
      h.textarea([
        h.Value(model.prompt),
        h.AriaLabel("Prompt"),
        h.Placeholder(Option.getOrElse(Option.orElse(ownAnswerPrompt(model, address), () => suggestion(model, address)), () => "")),
        h.OnInput((text) => Message.UpdatedPrompt({ text })),
      ]),
      h.button([h.Type("submit")], ["send"]),
    ],
  )

/**
 * The model a Claude Code agent answers with, as a button that opens the
 * model menu. Its exact id shows on hover.
 */
const modelTagView = (address: string, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.toArray(
    Option.map(Record.get(model.models, address), (id) =>
      h.button(
        [
          h.Type("button"),
          h.Class(isPickingModel(model, address) ? "model-tag on" : "model-tag"),
          h.Title(id),
          h.AriaLabel(`model: ${modelName(id)}; pick another`),
          h.AriaExpanded(isPickingModel(model, address)),
          h.OnClick(Message.ClickedModelTag({ address })),
        ],
        [modelName(id)],
      ),
    ),
  )

/** The models `/model` takes by alias, newest family first; each alias picks that family's latest. */
const MODELS = [
  { alias: "fable", name: "Fable" },
  { alias: "opus", name: "Opus" },
  { alias: "sonnet", name: "Sonnet" },
  { alias: "haiku", name: "Haiku" },
]

const modelMenuView = (address: string, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  isPickingModel(model, address)
    ? [
        h.div(
          [h.Class("model-menu"), h.Role("menu"), h.AriaLabel("models")],
          [
            ...Array.map(MODELS, ({ alias, name }) => {
              const isCurrent = Option.exists(Record.get(model.models, address), (id) => String.startsWith(`${name} `)(modelName(id)))
              return h.button(
                [h.Type("button"), h.Class(isCurrent ? "chip on" : "chip"), h.Role("menuitem"), h.AriaCurrent(isCurrent ? "true" : "false"), h.OnClick(Message.PickedModel({ address, alias }))],
                [name],
              )
            }),
            h.span([h.Class("note")], ["Claude Code may also keep the pick for its new sessions."]),
          ],
        ),
      ]
    : []

const isPickingModel = (model: Model, address: string) => model.paneAction._tag === "PickingModel" && model.paneAction.address === address
