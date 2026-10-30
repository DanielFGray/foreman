// Slash command suggestions over the prompt. When the prompt starts a
// command, the page reads the agent's commands from the bridge and lists the
// ones that match; a tap writes the command into the prompt and sends nothing.
import { Array, Option, Order, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import type { SlashCommand } from "../shared/SlashCommand.ts"
import { ListCommands } from "./commands.ts"
import { CommandList, Message, type Model, type UpdateReturn } from "./model.ts"
import { maybeFocus, supportsAt } from "./selection.ts"

/** Rows the list shows at most. */
const MOST = 8

/**
 * The commands that match the prompt, when it starts with a slash. Names
 * that start with what follows the slash come first, then the ones that
 * hold it. Once a space follows the name, only that command shows, so its
 * hint stays in view while its argument is typed.
 */
export const suggestions = (commands: ReadonlyArray<SlashCommand>, prompt: string): ReadonlyArray<SlashCommand> =>
  Option.match(commandTyped(prompt), {
    onNone: () => [],
    onSome: ({ query, hasArgument }) =>
      hasArgument
        ? Array.filter(commands, ({ name }) => String.toLowerCase(name) === String.toLowerCase(query))
        : Array.take(
            Array.sort(
              Array.filter(commands, ({ name }) => String.includes(String.toLowerCase(query))(String.toLowerCase(name))),
              Order.mapInput(Order.Boolean, ({ name }: SlashCommand) => !String.startsWith(String.toLowerCase(query))(String.toLowerCase(name))),
            ),
            MOST,
          ),
  })

/** The prompt changed: it reads the agent's commands again when it starts a command. */
export const updatedPrompt = (model: Model, text: string): UpdateReturn => {
  const next = modifyFields(model, { prompt: () => text })
  return Option.match(
    Option.filter(maybeFocus(model), (address) => supportsAt(model, address, "commands") && Option.isSome(commandTyped(text)) && Option.isNone(commandTyped(model.prompt))),
    {
      onNone: () => ({ model: next }),
      onSome: (address) => ({ model: modifyFields(next, { commandList: () => CommandList.Loading({ address }) }), commands: [ListCommands({ address })] }),
    },
  )
}

/** A list read for another agent, or an older one, is not this prompt's. */
export const listedCommands = (model: Model, address: string, list: CommandList): Model =>
  modifyFields(model, { commandList: (now) => (now._tag === "Loading" && now.address === address ? list : now) })

export const pickedCommand = (model: Model, name: string): Model => modifyFields(model, { prompt: () => `/${name} ` })

/** The suggestions over the prompt of the agent at `address`; nothing while the prompt starts no command. */
export const slashView = (model: Model, address: string, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.isNone(commandTyped(model.prompt))
    ? []
    : CommandList.match(model.commandList, {
        Unread: () => [],
        Loading: (list) => (list.address === address ? [note("Reading the commands…", h)] : []),
        Unlisted: (list) => (list.address === address ? [note(`The commands cannot be read: ${list.reason}`, h)] : []),
        Listed: (list) => (list.address === address ? listView(suggestions(list.commands, model.prompt), Option.exists(commandTyped(model.prompt), ({ hasArgument }) => hasArgument), h) : []),
      })

const commandTyped = (prompt: string) =>
  String.startsWith("/")(prompt)
    ? Option.some({ query: Option.getOrElse(Array.head(String.split(prompt.slice(1), /\s/)), () => ""), hasArgument: /\s/.test(prompt) })
    : Option.none()

const note = (text: string, h: HtmlBuilder<Message>) => h.p([h.Class("slash-note note")], [text])

const listView = (found: ReadonlyArray<SlashCommand>, isWritten: boolean, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Array.isReadonlyArrayEmpty(found)
    ? []
    : [
        h.ul(
          [h.Class("slash-list"), h.AriaLabel("commands")],
          Array.map(found, (command) => {
            const row = [
              h.span([h.Class("slash-name")], [`/${command.name}`]),
              ...Option.toArray(Option.map(command.hint, (hint) => h.span([h.Class("slash-hint")], [hint]))),
              h.span([h.Class("slash-description")], [command.description]),
            ]
            // Once the command is written, its row only shows what it takes.
            return h.li(
              [],
              isWritten
                ? [h.div([h.Class("slash-row")], row)]
                : [
                    h.button(
                      [
                        h.Type("button"),
                        h.Class("slash-row"),
                        h.AriaLabel(`/${command.name}`),
                        h.OnClick(Message.PickedCommand({ name: command.name }), { focusSelector: ".prompt textarea" }),
                      ],
                      row,
                    ),
                  ],
            )
          }),
        ),
      ]
