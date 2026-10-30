import { Option } from "effect"
import { expect, test } from "vitest"
import type { Terminal } from "../shared/Fleet.ts"
import { terminalLabel } from "./group.ts"
import { programOf } from "./programs.ts"

const running = (name: string, ...argv: ReadonlyArray<string>): Terminal => ({
  address: "t1",
  name: Option.none(),
  title: Option.none(),
  cwd: "/",
  state: "live",
  status: Option.none(),
  foreground: Option.some({ name, pid: 1, argv: [name, ...argv] }),
  labels: {},
  created_ms: 0,
})

const nameOf = (terminal: Terminal) => Option.map(programOf(terminal), ({ name }) => name)

test("a known program shows its display name, whatever its path or case", () => {
  expect(nameOf(running("nvim", "notes.md"))).toEqual(Option.some("Neovim"))
  expect(nameOf(running("/usr/bin/HTOP"))).toEqual(Option.some("htop"))
  expect(nameOf(running("zsh"))).toEqual(Option.some("zsh"))
})

test("a runner's test subcommand shows as tests, and another subcommand as the runner", () => {
  expect(nameOf(running("bun", "test"))).toEqual(Option.some("tests"))
  expect(nameOf(running("cargo", "test", "--release"))).toEqual(Option.some("tests"))
  expect(nameOf(running("bun", "run", "test"))).toEqual(Option.some("bun"))
  expect(nameOf(running("vim", "test"))).toEqual(Option.some("Vim"))
})

test("an agent shows as its product, and an unknown program as its own name", () => {
  expect(nameOf(running("claude"))).toEqual(Option.some("Claude Code"))
  expect(nameOf(running("frobnicate"))).toEqual(Option.some("frobnicate"))
  expect(terminalLabel(running("bun", "test"))).toBe("tests")
})

test("a terminal with no foreground program has none", () => {
  expect(programOf({ ...running("zsh"), foreground: Option.none() })).toEqual(Option.none())
})
