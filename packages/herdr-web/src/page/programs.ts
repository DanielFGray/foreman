// What a terminal's foreground program is called and drawn as: a coding agent
// by its product, a test run by the word "tests", a common tool by a fixed
// table, and anything else by its own name.
import { Array, HashMap, Option, pipe, String } from "effect"
import type { Terminal } from "../shared/Fleet.ts"
import { harnessOf } from "../shared/Harness.ts"
import { Activity, Bot, BookOpen, FlaskConical, GitBranch, Hammer, type IconNode, KeyRound, Play, SquarePen, SquareTerminal } from "./icons.ts"

export type Program = Readonly<{ name: string; icon: IconNode }>

/** The terminal's agent or foreground program as the user knows it; none when neither is known. */
export const programOf = (terminal: Terminal): Option.Option<Program> =>
  pipe(
    harnessOf(terminal),
    Option.map(({ name }): Program => ({ name, icon: Bot })),
    Option.orElse(() =>
      Option.flatMap(terminal.foreground, ({ name, argv }) => {
        const program = lastSegment(name)
        return isTestRun(program, argv)
          ? Option.some<Program>({ name: "tests", icon: FlaskConical })
          : Option.orElse(HashMap.get(KNOWN, program), () => Option.some<Program>({ name: program, icon: SquareTerminal }))
      }),
    ),
  )

// `bun test`, `cargo test`, `go test`: the subcommand decides, not the program.
const isTestRun = (program: string, argv: ReadonlyArray<string>) =>
  Array.contains(TEST_RUNNERS, program) && Array.contains(Array.take(Array.drop(argv, 1), 1), "test")

const TEST_RUNNERS = ["bun", "npm", "pnpm", "yarn", "cargo", "go"]

const lastSegment = (path: string) => pipe(String.split(path, "/"), Array.last, Option.getOrElse(() => path), String.toLowerCase)

// Each group draws with one icon; a program's name is its own unless the pair says otherwise.
const GROUPS: ReadonlyArray<readonly [IconNode, ReadonlyArray<string | readonly [string, string]>]> = [
  [SquareTerminal, ["zsh", "bash", "fish", "sh", "dash", "nu"]],
  [SquarePen, [["vim", "Vim"], ["nvim", "Neovim"], ["emacs", "Emacs"], ["nano", "nano"], ["hx", "Helix"], ["helix", "Helix"]]],
  [Play, ["bun", "node", "npm", "pnpm", "cargo", "go", "python", "python3"]],
  [Hammer, ["make"]],
  [Activity, ["htop", "btop", "top"]],
  [GitBranch, ["git"]],
  [KeyRound, ["ssh"]],
  [BookOpen, ["less", "man"]],
]

const KNOWN = HashMap.fromIterable(
  Array.flatMap(GROUPS, ([icon, programs]) =>
    Array.map(programs, (entry) => {
      const [program, name] = typeof entry === "string" ? [entry, entry] : entry
      return [program, { name, icon }] as const
    }),
  ),
)
