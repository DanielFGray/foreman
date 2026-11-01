// Messages for an agent, held until it can take them. A message waits while
// the agent works, waits on a question, or holds text in its own input box
// that the page did not write there (see mirror.ts), and goes as soon as none
// of these is so. The page's own text in the box is emptied as the message
// goes. The input box counts only for an agent whose box the page reads. The
// queue lives in the page, so it outlasts a lost connection to the bridge.
import { Array, Option, Record, Schema as S, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import { InputBox } from "../shared/Chat.ts"
import { SendPrompt } from "./commands.ts"
import { Message, type Model, type Queued, QueueState, type UpdateReturn } from "./model.ts"
import { isWriting, ownText, promptOf } from "./mirror.ts"
import { lastFleet, supportsAt } from "./selection.ts"
import { refusedPrompt, sentPrompt } from "./waiting.ts"

/** Puts a message at the end of the agent's queue, and sends what may go. */
export const queued = (model: Model, address: string, text: string): UpdateReturn =>
  drained(
    modifyFields(model, {
      queued: (all) => Array.append(all, { address, id: nextId(all), text, state: QueueState.Waits() }),
    }),
  )

/**
 * Sends the first message of each agent's queue, when the agent can take it
 * and nothing else of its queue is on its way. One message goes at a time, so
 * the queue keeps its order.
 */
export const drained = (model: Model): UpdateReturn => {
  const due = Array.getSomes(
    Array.map(Array.dedupe(Array.map(model.queued, ({ address }) => address)), (address) =>
      Option.filter(Array.findFirst(model.queued, (one) => one.address === address), (first) => first.state._tag === "Waits" && Option.isNone(blocker(model, address))),
    ),
  )
  return {
    model: Array.reduce(due, model, (sofar, one) => sending(sofar, one)),
    commands: Array.map(due, ({ address, id, text }) => SendPrompt({ address, id, text, whileWorking: false, replaces: ownText(model, address) })),
  }
}

/** Sends one message now, past the agent's turn; Claude Code holds it until the turn ends. */
export const sentNow = (model: Model, address: string, id: number): UpdateReturn =>
  Option.match(
    Array.findFirst(model.queued, (one) => one.address === address && one.id === id && one.state._tag !== "Sending"),
    {
      onNone: () => ({ model }),
      onSome: (one) => ({ model: sending(model, one), commands: [SendPrompt({ address, id, text: one.text, whileWorking: true, replaces: ownText(model, address) })] }),
    },
  )

export const dropped = (model: Model, address: string, id: number): Model =>
  modifyFields(model, { queued: (all) => Array.filter(all, (one) => one.address !== address || one.id !== id || one.state._tag === "Sending") })

/** The agent took the message. */
export const delivered = (model: Model, address: string, id: number): UpdateReturn =>
  drained(modifyFields(model, { queued: (all) => Array.filter(all, (one) => one.address !== address || one.id !== id) }))

/** The bridge refused the message; it is held, with the reason, until something about the agent changes. */
export const held = (model: Model, address: string, id: number, reason: string): Model =>
  Option.match(
    Array.findFirst(model.queued, (one) => one.address === address && one.id === id),
    {
      onNone: () => model,
      onSome: ({ text }) =>
        modifyFields(refusedPrompt(model, address, text), {
          queued: (all) => Array.map(all, (one) => (one.address === address && one.id === id ? { ...one, state: QueueState.Held({ reason }) } : one)),
        }),
    },
  )

/**
 * After news of the agents, `before` being the model the news arrived to: a
 * held message waits again once its agent's status, its input box, or the
 * page's connection changed, and what may go is sent.
 */
export const reconsidered = (before: Model, model: Model): UpdateReturn =>
  drained(
    modifyFields(model, {
      queued: (all) =>
        Array.map(all, (one) =>
          one.state._tag === "Held" && !sameAgent(signOf(before, one.address), signOf(model, one.address)) ? { ...one, state: QueueState.Waits() } : one,
        ),
    }),
  )

/** The agents whose input box the page reads: those in a shown chat, and those with messages queued. */
export const watchedBoxes = (model: Model, shown: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.dedupe([...shown, ...Array.map(model.queued, ({ address }) => address)])

/** What the prompt says while the agent's input box shows a suggested prompt. */
export const suggestion = (model: Model, address: string): Option.Option<string> =>
  Option.flatMap(Record.get(model.boxes, address), (box) => (box._tag === "Suggestion" ? Option.some(box.text) : Option.none()))

/**
 * The agent's queue over its prompt, and a word on its own input box: text
 * typed there that the prompt does not show, or why the page could not write
 * the box.
 */
export const queueView = (model: Model, address: string, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const mine = Array.filter(model.queued, (one) => one.address === address)
  const draft = Option.filter(
    Option.flatMap(Record.get(model.boxes, address), (box) => (box._tag === "Draft" || box._tag === "Partial" ? Option.some(box.text) : Option.none())),
    () => Option.isNone(ownText(model, address)),
  )
  return [
    ...Option.toArray(
      Option.map(draft, (text) =>
        h.p([h.Class("note queue-draft")], [`The agent's input box in the terminal holds "${String.trim(text)}". Messages wait until it is empty.`]),
      ),
    ),
    ...Option.toArray(
      Option.map(promptOf(model, address).problem, (reason) => h.p([h.Class("note queue-draft box-problem")], [`The page could not write the agent's input box: ${reason}.`])),
    ),
    ...(Array.isReadonlyArrayNonEmpty(mine) ? [h.ol([h.Class("queue"), h.AriaLabel("Queued messages")], Array.map(mine, (one) => queuedView(model, one, h)))] : []),
  ]
}

const queuedView = (model: Model, { address, id, text, state }: Queued, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(
    `${id}`,
    [h.Class("queued")],
    [
      h.span([h.Class("queued-text"), h.Title(text)], [text]),
      h.span(
        [h.Class(state._tag === "Held" ? "queued-state error" : "queued-state")],
        [QueueState.match(state, { Waits: () => Option.getOrElse(blocker(model, address), () => "goes next"), Sending: () => "sending…", Held: ({ reason }) => reason })],
      ),
      h.button(
        [h.Type("button"), h.Class("chip"), h.Disabled(state._tag === "Sending"), h.OnClick(Message.ClickedSendNow({ address, id }))],
        ["Send now"],
      ),
      h.button(
        [h.Type("button"), h.Class("chip"), h.AriaLabel("drop it"), h.Title("drop it"), h.Disabled(state._tag === "Sending"), h.OnClick(Message.ClickedDropQueued({ address, id }))],
        ["×"],
      ),
    ],
  )

const sending = (model: Model, { address, id, text }: Queued): Model =>
  modifyFields(sentPrompt(model, address, text), {
    queued: (all) => Array.map(all, (one) => (one.address === address && one.id === id ? { ...one, state: QueueState.Sending() } : one)),
  })

/** What keeps the agent from taking a message now, if anything, in words for the queue. */
const blocker = (model: Model, address: string): Option.Option<string> => {
  const state = Option.flatMap(terminalAt(model, address), ({ status }) => Option.map(status, ({ state }) => state))
  return model.bridge._tag !== "Watching"
    ? Option.some("waits for the bridge")
    : Option.contains(state, "working")
      ? Option.some("waits for the agent's turn to end")
      : Option.contains(state, "blocked")
        ? Option.some("waits for the agent's question to be answered")
        : supportsAt(model, address, "inputBox")
          ? boxBlocker(model, address)
          : Option.none()
}

// Text the page itself wrote into the box is emptied when the message goes.
const boxBlocker = (model: Model, address: string): Option.Option<string> =>
  isWriting(model, address)
    ? Option.some("waits for the page to write the agent's input box")
    : Option.match(Record.get(model.boxes, address), {
        onNone: () => Option.some("waits for a reading of the agent's input box"),
        onSome: (box) =>
          (box._tag === "Draft" || box._tag === "Partial") && Option.isNone(ownText(model, address)) ? Option.some("waits for the agent's input box to empty") : Option.none(),
      })

// What a held message waits on a change of.
const Sign = S.Struct({ isConnected: S.Boolean, statusMs: S.Option(S.Int), box: S.Option(InputBox) })

const sameAgent = S.toEquivalence(Sign)

const signOf = (model: Model, address: string): typeof Sign.Type => ({
  isConnected: model.bridge._tag === "Watching",
  statusMs: Option.flatMap(terminalAt(model, address), ({ status_ms }) => status_ms),
  box: Record.get(model.boxes, address),
})

const terminalAt = (model: Model, address: string) =>
  Option.flatMap(lastFleet(model.bridge), ({ terminals }) => Array.findFirst(terminals, (terminal) => terminal.address === address))

const nextId = (all: ReadonlyArray<Queued>) => Array.reduce(all, 0, (most, { id }) => Math.max(most, id + 1))
