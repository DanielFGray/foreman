// The chat as the page lists it, one turn at a time. A turn starts at a
// prompt or a command. Its work (tool calls, and the replies the agent writes
// between them) folds into one item, and its last reply stays outside the
// fold as the answer. A turn of fifty tool calls reads as one line.
import { Array, HashMap, Match, Option, Result, Schema as S, Tuple } from "effect"
import { Block, type Entry } from "../shared/Chat.ts"

export const Outcome = S.Literals(["running", "succeeded", "failed"])
export type Outcome = typeof Outcome.Type

export const Call = S.TaggedStruct("Call", { id: S.String, name: S.String, summary: S.String, outcome: Outcome })
export type Call = typeof Call.Type

/** A reply written while the turn was still working. */
export const Note = S.TaggedStruct("Note", { id: S.String, blocks: S.Array(Block) })
export type Note = typeof Note.Type

export const Step = S.Union([Call, Note])
export type Step = typeof Step.Type

/** A turn's work, in the order it happened. */
export const Work = S.TaggedStruct("Work", { id: S.String, steps: S.NonEmptyArray(Step) })
export type Work = typeof Work.Type

export type Item = Exclude<Entry, { _tag: "Tool" | "ToolResult" }> | Work

export const foldEntries = (entries: ReadonlyArray<Entry>): ReadonlyArray<Item> => {
  const results = HashMap.fromIterable(
    Array.filterMap(entries, (entry) =>
      Match.value(entry).pipe(
        Match.tag("ToolResult", ({ toolUseId, isError }) => Result.succeed(Tuple.make(toolUseId, isError))),
        Match.orElse(() => Result.failVoid),
      ),
    ),
  )
  const outcome = (toolUseId: string): Outcome =>
    Option.match(HashMap.get(results, toolUseId), {
      onNone: () => "running",
      onSome: (isError) => (isError ? "failed" : "succeeded"),
    })
  const step = (entry: Entry): Option.Option<Step> =>
    Match.value(entry).pipe(
      Match.tag("Tool", ({ id, name, summary, toolUseId }) =>
        Option.some(Call.make({ id, name, summary, outcome: outcome(toolUseId) })),
      ),
      Match.tag("Reply", ({ id, blocks }) => Option.some(Note.make({ id, blocks }))),
      Match.orElse(() => Option.none()),
    )
  return Array.flatMap(turns(entries), (turn) => foldTurn(turn, step))
}

type Turn = ReadonlyArray<Entry>

/** Splits the entries before each prompt or command, and at a compaction, which can fall inside a turn. */
const turns = (entries: ReadonlyArray<Entry>): ReadonlyArray<Turn> =>
  Array.reduce(entries, Array.empty<Turn>(), (split, entry) =>
    Option.match(Array.last(split), {
      onSome: (turn) =>
        opensTurn(entry) ? Array.append(split, [entry]) : Array.append(Array.dropRight(split, 1), Array.append(turn, entry)),
      onNone: () => [[entry]],
    }),
  )

const opensTurn = (entry: Entry) => entry._tag === "Prompt" || entry._tag === "Command" || entry._tag === "Compacted"

const foldTurn = (turn: Turn, step: (entry: Entry) => Option.Option<Step>): ReadonlyArray<Item> => {
  const opener = Option.filter(Array.head(turn), opensTurn)
  const body = Option.match(opener, { onNone: () => turn, onSome: () => Array.drop(turn, 1) })
  const steps = Array.getSomes(Array.map(body, step))
  // The last reply is the answer, unless the agent went on working after it.
  const answer = Option.flatMap(
    Option.filter(Array.last(steps), (last) => last._tag === "Note"),
    () => Option.flatMap(Array.findLast(body, (entry) => entry._tag === "Reply"), shownAlone),
  )
  const work = Option.match(answer, { onNone: () => steps, onSome: () => Array.dropRight(steps, 1) })
  const marks = Array.getSomes(Array.map(body, (entry) => (opensTurn(entry) || entry._tag === "Reply" ? Option.none() : shownAlone(entry))))
  return [
    ...Array.getSomes([Option.flatMap(opener, shownAlone)]),
    ...Array.match(work, { onEmpty: () => [], onNonEmpty: (all) => [Work.make({ id: Array.headNonEmpty(all).id, steps: all })] }),
    ...Array.getSomes([answer]),
    ...marks,
  ]
}

/** The entry as an item of its own; tool calls and results only show inside Work. */
const shownAlone = (entry: Entry): Option.Option<Item> =>
  Match.value(entry).pipe(
    Match.tags({ Tool: () => Option.none(), ToolResult: () => Option.none() }),
    Match.orElse((other) => Option.some(other)),
  )
