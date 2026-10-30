import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array, Option } from "effect"
import { afterAll, describe, expect, test } from "vitest"
import { BUILT_INS, commandsOf, frontmatterOf, parseRecords, scanArgv } from "./Commands.ts"

// Git keeps no file named .git, so the copy gets the marker that ends the
// repository: the project folders stop at home/repo.
const FIXTURE = mkdtempSync(join(tmpdir(), "commands-"))
cpSync(new URL("./fixtures/commands", import.meta.url).pathname, FIXTURE, { recursive: true })
writeFileSync(`${FIXTURE}/home/repo/.git`, "gitdir: /nowhere\n")
afterAll(() => rmSync(FIXTURE, { recursive: true, force: true }))

// The scan runs here, with the fixture as home, as hc runs it on the agent's machine.
const scan = (script: "own" | "plugins", args: ReadonlyArray<string>, cwd: string) =>
  parseRecords(Bun.spawnSync(scanArgv(script, args), { cwd, env: { HOME: `${FIXTURE}/home`, PATH: process.env["PATH"] ?? "" } }).stdout.toString())

const names = (commands: ReadonlyArray<{ name: string; origin: string }>) => Array.map(commands, ({ name, origin }) => `${origin} ${name}`)

describe("the commands for an agent's folder", () => {
  const own = scan("own", [], `${FIXTURE}/home/repo/app`)
  const plugins = scan("plugins", ["plug", `${FIXTURE}/plug`], "/")
  const commands = commandsOf([...own, ...plugins], { skillOverrides: { hush: "off" } })

  test("skills, then command files, the user's before the project's up to the repository's root, then the plugins', then the built-ins left", () => {
    expect(names(commands)).toEqual([
      "user compact",
      "user tidy",
      "project ship",
      "user git:push",
      "project test",
      "plugin plug:lint",
      "plugin plug:go",
      ...Array.map(Array.filter(BUILT_INS, ({ name }) => name !== "compact"), ({ name }) => `built-in ${name}`),
    ])
  })

  test("a command's description is its frontmatter's, or its first line; its hint is its argument-hint", () => {
    expect(Array.filter(commands, ({ name }) => ["tidy", "git:push", "test"].includes(name))).toEqual([
      { name: "tidy", description: "Tidy the code, then check it.", hint: Option.none(), origin: "user" },
      { name: "git:push", description: "Push the branch.", hint: Option.some("<branch>"), origin: "user" },
      { name: "test", description: "Run the tests.", hint: Option.none(), origin: "project" },
    ])
  })

  test("the scan reads the user's settings, so it can find the turned-on plugins", () => {
    expect(Array.map(Array.filter(own, ({ kind }) => kind === "json"), ({ path }) => path.slice(FIXTURE.length))).toEqual(["/home/.claude/settings.json"])
  })

  test("a folder at home reads only the user's own commands", () => {
    expect(Array.every(scan("own", [], `${FIXTURE}/home`), ({ origin }) => origin !== "project")).toBe(true)
  })
})

test("frontmatter that is not YAML leaves the file's first line as its description", () => {
  expect(frontmatterOf("---\n: : [\n---\nDo the thing.\n")).toEqual({ fields: {}, body: "Do the thing.\n" })
})
