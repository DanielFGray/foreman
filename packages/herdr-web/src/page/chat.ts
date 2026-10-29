// The chat as the page lists it: tool calls in a row fold into one item, each
// call marked with its result, so a turn of fifty tool calls reads as one line.
import { Array, HashMap, Option, Result, Schema } from "effect"
import type { Entry } from "../shared/Chat.ts"

export const Outcome = Schema.Literals(["running", "succeeded", "failed"])
export type Outcome = typeof Outcome.Type

export const Call = Schema.Struct({ id: Schema.String, name: Schema.String, summary: Schema.String, outcome: Outcome })
export type Call = typeof Call.Type

/** Tool calls made one after another, with no text between them. */
export const Tools = Schema.TaggedStruct("Tools", { id: Schema.String, calls: Schema.NonEmptyArray(Call) })
export type Tools = typeof Tools.Type

export type Item = Exclude<Entry, { _tag: "Tool" | "ToolResult" }> | Tools

/** Folds runs of tool calls into Tools items. A result never shows on its own; it marks its call. */
export const foldEntries = (entries: ReadonlyArray<Entry>): ReadonlyArray<Item> => {
  const results = HashMap.fromIterable(
    Array.filterMap(entries, (entry) =>
      entry._tag === "ToolResult" ? Result.succeed([entry.toolUseId, entry.isError] as const) : Result.failVoid,
    ),
  )
  const outcome = (toolUseId: string): Outcome =>
    Option.match(HashMap.get(results, toolUseId), {
      onNone: () => "running",
      onSome: (isError) => (isError ? "failed" : "succeeded"),
    })

  return Array.reduce(entries, Array.empty<Item>(), (items, entry) => {
    if (entry._tag === "ToolResult") {
      return items
    }
    if (entry._tag !== "Tool") {
      return Array.append(items, entry)
    }
    const call: Call = { id: entry.id, name: entry.name, summary: entry.summary, outcome: outcome(entry.toolUseId) }
    return Option.match(Array.last(items), {
      onSome: (last) =>
        last._tag === "Tools"
          ? Array.append(Array.dropRight(items, 1), { ...last, calls: Array.append(last.calls, call) })
          : Array.append(items, Tools.make({ id: entry.id, calls: [call] })),
      onNone: () => [Tools.make({ id: entry.id, calls: [call] })],
    })
  })
}
