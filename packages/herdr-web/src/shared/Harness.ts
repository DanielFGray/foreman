// Which coding agent runs in a terminal, and what the page can do with it.// An agent is known by the app it names in its status report, else by the
// foreground program's name. The names follow herdr's own table
// (src/detect/mod.rs, `lookup_agent`). herdr also reads the argv of `node`,
// `bun` and `python` to find an agent that runs under one; this table reads
// only the program's name, so those stay unknown.
//
// Each feature an agent lists here, the bridge implements in that agent's
// adapter (src/server/Agents.ts); the types hold the two to the same list.
import { Array, HashMap, Option, pipe, Schema as S, String } from "effect"
import type { Terminal } from "./Fleet.ts"

/**
 * What the page offers for an agent beyond its terminal: its chat, its model
 * and the models it may switch to, its input box (which tells when it takes a
 * message), the questions it asks, its slash commands, its todo list, and
 * pairing: a sign-in to the agent's own server, which some of the others need.
 */
export type Feature = "chat" | "model" | "inputBox" | "questions" | "commands" | "todos" | "pairing"

/** A model the agent may switch to: what the agent takes, and what the page calls it. */
export const ModelChoice = S.Struct({ alias: S.String, name: S.String })
export type ModelChoice = typeof ModelChoice.Type

/** The models the agent may switch to, the one it uses now, and a note under them. */
export const ModelChoices = S.Struct({ choices: S.Array(ModelChoice), current: S.Option(S.String), note: S.String })
export type ModelChoices = typeof ModelChoices.Type

export type Harness = Readonly<{
  /** What the agent names itself in its status report, such as `claude-code`; an agent not yet seen to report goes by its main program. */
  id: string
  /** Its product name, such as "Claude Code". */
  name: string
  programs: ReadonlyArray<string>
  features: ReadonlyArray<Feature>
}>

/** The agent hc reports in the terminal; none for a shell or another program. */
export const harnessOf = ({ status, foreground }: Terminal): Option.Option<Harness> =>
  pipe(
    Option.flatMap(status, ({ app }) => Option.flatMap(app, named)),
    Option.orElse(() => Option.flatMap(foreground, ({ name }) => named(name))),
  )

export const supports = (terminal: Terminal, feature: Feature) => Option.exists(harnessOf(terminal), ({ features }) => Array.contains(features, feature))

const terminalOnly = <const Id extends string>(id: Id, name: string, programs: ReadonlyArray<string>) =>
  ({ id, name, programs, features: [] }) as const satisfies Harness

export const HARNESSES = [
  terminalOnly("pi", "Pi", ["pi"]),
  {
    id: "claude-code",
    name: "Claude Code",
    programs: ["claude"],
    features: ["chat", "model", "inputBox", "questions", "commands", "todos"],
  },
  terminalOnly("codex", "Codex", ["codex"]),
  terminalOnly("gemini", "Gemini", ["gemini"]),
  terminalOnly("cursor", "Cursor", ["cursor", "cursor-agent"]),
  terminalOnly("devin", "Devin", ["devin", "devin-cli"]),
  terminalOnly("antigravity", "Antigravity", ["agy", "antigravity-cli"]),
  terminalOnly("cline", "Cline", [".cline"]),
  terminalOnly("omp", "omp", ["omp"]),
  terminalOnly("mastracode", "Mastra Code", ["mastra-code"]),
  { id: "opencode", name: "OpenCode", programs: ["opencode2", "open-code"], features: ["chat", "model", "commands", "todos", "pairing"] },
  terminalOnly("copilot", "Copilot", ["github-copilot", "ghcs"]),
  terminalOnly("kimi", "Kimi", ["kimi-code"]),
  terminalOnly("kiro", "Kiro", ["kiro-cli"]),
  terminalOnly("droid", "Droid", ["droid"]),
  terminalOnly("amp", "Amp", ["amp-local"]),
  terminalOnly("grok", "Grok", ["grok-build"]),
  terminalOnly("hermes", "Hermes", ["hermes-agent"]),
  terminalOnly("kilo", "Kilo", ["kilo-code"]),
  terminalOnly("qoder", "Qoder", ["qodercli", "qoderclicn", "qodercn"]),
  terminalOnly("qwen", "Qwen", ["qwen-code"]),
  terminalOnly("letta", "Letta", ["letta-code"]),
  terminalOnly("maki", "Maki", ["maki"]),
  terminalOnly("muse", "Muse", ["muse-code", "muse-cli"]),
] as const satisfies ReadonlyArray<Harness>

export type HarnessId = (typeof HARNESSES)[number]["id"]

/** The agents that list `feature`. */
export type HarnessWith<F extends Feature> = (typeof HARNESSES)[number] extends infer H
  ? H extends { id: infer Id; features: ReadonlyArray<infer Listed> }
    ? F extends Listed
      ? Id
      : never
    : never
  : never

// A path-qualified name counts by its last segment, in any case. An agent's
// id names it too, as its status report does.
const named = (program: string) =>
  pipe(String.split(program, "/"), Array.last, Option.map(String.toLowerCase), Option.flatMap((name) => HashMap.get(BY_NAME, name)))

const BY_NAME = HashMap.fromIterable(
  Array.flatMap(HARNESSES, (harness): ReadonlyArray<readonly [string, Harness]> => Array.map([harness.id, ...harness.programs], (name) => [name, harness] as const)),
)
