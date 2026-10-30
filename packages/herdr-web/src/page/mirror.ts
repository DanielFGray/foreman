// Each agent's prompt, and its mirror in the agent's own input box in the
// terminal. For an agent whose box the page reads, what is typed on either side
// shows on the other. The page compares each reading of the box with the text
// both sides last agreed on (`Prompt.agreed`):
//   - a box that changed in the terminal gives the prompt its text, when the
//     prompt is as agreed too;
//   - a prompt the user edited goes into the box once typing pauses, when the
//     box is as agreed, or holds text the page can read in full;
//   - the bridge's reading of the box after each write is the new agreement,
//     since the screen shows a text with Claude Code's own line breaks.
// Only one writer touches a box at a time: no write starts while another is
// on its way, or while a message of the agent's queue is.
import { Array, Option, Record } from "effect"
import { modifyFields } from "foldkit/struct"
import { type InputBox, sameTyped, typedText } from "../shared/Chat.ts"
import { WriteInputBox } from "./commands.ts"
import type { Model, Prompt, UpdateReturn } from "./model.ts"
import { maybeFocus, supportsAt } from "./selection.ts"

export const promptOf = (model: Model, address: string): Prompt => Option.getOrElse(Record.get(model.prompts, address), () => EMPTY)

/** The user edited the prompt of the agent at `address`; its box follows once typing pauses (see `pendingEdit`). */
export const edited = (model: Model, address: string, text: string): Model => withPrompt(model, address, (prompt) => ({ ...prompt, text }))

/** Typing paused with the prompt at `text`; the prompt goes into the box unless the user typed on. */
export const paused = (model: Model, address: string, text: string): UpdateReturn => (promptOf(model, address).text === text ? writeDue(model, address) : { model })

/**
 * The focused prompt's text, while the user edited it since the box last
 * agreed; a pause in typing, with this text unchanged, writes it into the box.
 */
export const pendingEdit = (model: Model): Option.Option<Readonly<{ address: string; text: string }>> =>
  Option.flatMap(
    Option.filter(maybeFocus(model), (address) => supportsAt(model, address, "inputBox")),
    (address) => {
      const { text, agreed } = promptOf(model, address)
      return text === agreed.text ? Option.none() : Option.some({ address, text })
    },
  )

/** The prompt was sent: it empties, and the box keeps its text until the message goes. */
export const submitted = (model: Model, address: string): Model => withPrompt(model, address, (prompt) => ({ ...prompt, text: "" }))

/** A new reading of the box; the box is already stored. */
export const boxRead = (model: Model, address: string, box: InputBox): Model => {
  const prompt = promptOf(model, address)
  return Option.match(
    Option.filter(typedText(box), (typed) => !prompt.isWriting && !sameTyped(typed, prompt.agreed.typed) && prompt.text === prompt.agreed.text && box._tag !== "Partial"),
    { onNone: () => model, onSome: (typed) => withPrompt(model, address, (now) => ({ ...now, text: typed, agreed: { text: typed, typed } })) },
  )
}

/** The bridge wrote `text` into the box, which then read `box`. */
export const wrote = (model: Model, address: string, text: string, box: InputBox): UpdateReturn =>
  writeDue(
    withPrompt(modifyFields(model, { boxes: (all) => Record.set(all, address, box) }), address, (prompt) => ({
      ...prompt,
      agreed: { text, typed: Option.getOrElse(typedText(box), () => "") },
      isWriting: false,
      problem: Option.none(),
    })),
    address,
  )

/** The bridge did not write the box. The next pause in typing tries again. */
export const failedWrite = (model: Model, address: string, reason: string): Model =>
  withPrompt(model, address, (prompt) => ({ ...prompt, isWriting: false, problem: Option.some(reason) }))

/** A message went to the agent, which leaves its box empty until the next reading. */
export const emptied = (model: Model, address: string): Model =>
  supportsAt(model, address, "inputBox")
    ? withPrompt(modifyFields(model, { boxes: (all) => Record.set(all, address, { _tag: "Empty" }) }), address, (prompt) => ({ ...prompt, agreed: { text: "", typed: "" } }))
    : model

/** What the page itself wrote into the box, while the box still holds just that. */
export const ownText = (model: Model, address: string): Option.Option<string> => {
  const { agreed } = promptOf(model, address)
  return Option.as(
    Option.filter(Option.flatMap(Record.get(model.boxes, address), typedText), (typed) => sameTyped(typed, agreed.typed)),
    agreed.typed,
  )
}

/** Whether a write to the box is on its way. */
export const isWriting = (model: Model, address: string) => promptOf(model, address).isWriting

/** Writes the prompt into the box, when the two differ and the box may take it. */
export const writeDue = (model: Model, address: string): UpdateReturn => {
  const prompt = promptOf(model, address)
  const isSending = Array.some(model.queued, (one) => one.address === address && one.state._tag === "Sending")
  return Option.match(
    Option.filter(
      Option.flatMap(Record.get(model.boxes, address), (box) => Option.map(typedText(box), (typed) => ({ box, typed }))),
      ({ box, typed }) => !prompt.isWriting && !isSending && prompt.text !== prompt.agreed.text && (sameTyped(typed, prompt.agreed.typed) || box._tag !== "Partial"),
    ),
    {
      onNone: () => ({ model }),
      onSome: ({ typed }) => ({
        model: withPrompt(model, address, (now) => ({ ...now, isWriting: true })),
        commands: [WriteInputBox({ address, expected: typed, text: prompt.text })],
      }),
    },
  )
}

const withPrompt = (model: Model, address: string, change: (prompt: Prompt) => Prompt): Model =>
  modifyFields(model, { prompts: (all) => Record.set(all, address, change(promptOf(model, address))) })

const EMPTY: Prompt = { text: "", agreed: { text: "", typed: "" }, isWriting: false, problem: Option.none() }
