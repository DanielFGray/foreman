// Which coding agent runs in a terminal, from what hc reports: the app an
// agent names in its status report, else the foreground program's name. The
// names follow herdr's own table (src/detect/mod.rs, `lookup_agent`). herdr
// also reads the argv of `node`, `bun` and `python` to find an agent that
// runs under one; hc reports only the program's name, so those stay unknown.
import { Array, HashMap, Option, pipe, String } from "effect"
import type { Terminal } from "../shared/Fleet.ts"

/** The agent's product name, such as "Claude Code"; none for a shell or another program. */
export const harnessOf = ({ status, foreground }: Terminal): Option.Option<string> =>
  pipe(
    Option.flatMap(status, ({ app }) => Option.flatMap(app, named)),
    Option.orElse(() => Option.flatMap(foreground, ({ name }) => named(name))),
  )

// A path-qualified name counts by its last segment, in any case.
const named = (program: string) =>
  pipe(String.split(program, "/"), Array.last, Option.map(String.toLowerCase), Option.flatMap((name) => HashMap.get(BY_PROGRAM, name)))

const HARNESSES: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["Pi", ["pi"]],
  ["Claude Code", ["claude", "claude-code"]],
  ["Codex", ["codex"]],
  ["Gemini", ["gemini"]],
  ["Cursor", ["cursor", "cursor-agent"]],
  ["Devin", ["devin", "devin-cli"]],
  ["Antigravity", ["agy", "antigravity", "antigravity-cli"]],
  ["Cline", ["cline", ".cline"]],
  ["omp", ["omp"]],
  ["Mastra Code", ["mastracode", "mastra-code"]],
  ["OpenCode", ["opencode", "opencode2", "open-code"]],
  ["Copilot", ["copilot", "github-copilot", "ghcs"]],
  ["Kimi", ["kimi", "kimi-code"]],
  ["Kiro", ["kiro", "kiro-cli"]],
  ["Droid", ["droid"]],
  ["Amp", ["amp", "amp-local"]],
  ["Grok", ["grok", "grok-build"]],
  ["Hermes", ["hermes", "hermes-agent"]],
  ["Kilo", ["kilo", "kilo-code"]],
  ["Qoder", ["qodercli", "qoderclicn", "qoder", "qodercn"]],
  ["Qwen", ["qwen", "qwen-code"]],
  ["Letta", ["letta", "letta-code"]],
  ["Maki", ["maki"]],
  ["Muse", ["muse", "muse-code", "muse-cli"]],
]

const BY_PROGRAM = HashMap.fromIterable(Array.flatMap(HARNESSES, ([product, programs]) => Array.map(programs, (program) => [program, product] as const)))
