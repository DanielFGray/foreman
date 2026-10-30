import { Array, Option } from "effect"
import { expect, test } from "vitest"
import type { SlashCommand } from "../shared/SlashCommand.ts"
import { suggestions } from "./slash.ts"

const command = (name: string): SlashCommand => ({ name, description: "", hint: Option.none(), origin: "user" })
const COMMANDS = Array.map(["clear", "compact", "context", "init", "model", "review", "git:push", "pr-review", "Recap", "tidy", "ship", "lint"], command)
const named = (prompt: string) => Array.map(suggestions(COMMANDS, prompt), ({ name }) => name)

test("a slash alone lists the commands, at most eight", () => {
  expect(named("/")).toEqual(["clear", "compact", "context", "init", "model", "review", "git:push", "pr-review"])
})

test("names that start with what is typed come first, then the ones that hold it, in any case", () => {
  expect(named("/re")).toEqual(["review", "Recap", "pr-review"])
  expect(named("/CO")).toEqual(["compact", "context"])
})

test("once a space follows the name, only that command shows", () => {
  expect(named("/compact keep the plan")).toEqual(["compact"])
  expect(named("/Compact keep")).toEqual(["compact"])
  expect(named("/comp now")).toEqual([])
})

test("a prompt that does not start with a slash lists nothing", () => {
  expect([named("clear"), named(" /clear"), named("")]).toEqual([[], [], []])
})
