// A prompt the user sent that the agent has not yet written to its
// transcript. The page draws it as a faded bubble so the chat does not look
// as if the prompt was lost. The agent's own entry replaces it.
import { Array, Option, Record, String } from "effect"
import { modifyFields } from "foldkit/struct"
import type { Entry } from "../shared/Chat.ts"
import { Conversation, type Model, View, type Waiting } from "./model.ts"

/** Milliseconds a prompt waits before its bubble shows a clock. */
export const CLOCK_AFTER = 5_000
/** Milliseconds a prompt waits before its bubble goes; the agent did not record it. */
export const GIVE_UP_AFTER = 60_000

/** A waiting prompt as the chat draws it. */
export type WaitingBubble = Readonly<{ text: string; isLate: boolean }>

/** Whether the line comes back as a prompt: a slash command or a shell line (`! ls`) never does. */
export const comesBackAsPrompt = (text: string) => {
  const line = String.trim(text)
  return String.isNonEmpty(line) && !String.startsWith("/")(line) && !String.startsWith("!")(line)
}

/** Starts the wait for a prompt just sent to the terminal at `address`. */
export const sentPrompt = (model: Model, address: string, text: string): Model =>
  comesBackAsPrompt(text)
    ? modifyFields(model, {
        waiting: (all) => Array.append(all, { address, text, seen: promptCount(entriesAt(model, address), text), sentAt: Option.none() }),
      })
    : model

/** Ends the wait for the prompt that the bridge did not take. */
export const refusedPrompt = (model: Model, address: string, text: string): Model =>
  modifyFields(model, {
    waiting: (all) => Array.filter(all, (one) => one.address !== address || !sameText(one.text, text)),
  })

/** After the clock reads `model.now`: a prompt just sent takes it as its time, and a wait that ran out ends. */
export const clocked = (model: Model): Model =>
  settled(
    modifyFields(model, {
      waiting: (all) => Array.map(all, (one) => ({ ...one, sentAt: Option.orElse(one.sentAt, () => Option.some(model.now)) })),
    }),
  )

/** Ends the waits that the conversation now answers or that ran out. */
export const settled = (model: Model): Model =>
  modifyFields(model, {
    waiting: (all) => Array.filter(all, (one) => !hasWaited(one, model.now, GIVE_UP_AFTER) && !isRecorded(one, entriesAt(model, one.address))),
  })

/** The prompts to draw as bubbles in the chat at `address`, oldest first. */
export const waitingAt = (model: Model, address: string): ReadonlyArray<WaitingBubble> =>
  Array.map(
    Array.filter(model.waiting, (one) => one.address === address),
    (one) => ({ text: one.text, isLate: hasWaited(one, model.now, CLOCK_AFTER) }),
  )

const hasWaited = ({ sentAt }: Waiting, now: number, limit: number) => Option.exists(sentAt, (at) => now - at >= limit)

// The agent recorded the prompt once the chat holds more prompts with its
// text than it held when the prompt was sent, so an earlier identical prompt
// does not count.
const isRecorded = ({ text, seen }: Waiting, entries: ReadonlyArray<Entry>) => promptCount(entries, text) > seen

const promptCount = (entries: ReadonlyArray<Entry>, text: string) =>
  Array.filter(entries, (entry) => entry._tag === "Prompt" && sameText(entry.text, text)).length

const sameText = (a: string, b: string) => String.trim(a) === String.trim(b)

const entriesAt = (model: Model, address: string): ReadonlyArray<Entry> =>
  Option.match(Record.get(model.views, address), {
    onNone: () => [],
    onSome: (view) =>
      View.match(view, {
        Chat: ({ conversation }) => Conversation.match(conversation, { Loading: () => [], Shown: ({ entries }) => entries, Unreadable: () => [] }),
        Terminal: () => [],
      }),
  })

