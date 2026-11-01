// The slash commands a Claude Code agent takes: a few built-ins, and the
// skills and command files Claude Code loads for the agent's folder, read on
// the agent's own machine through hc. The terminal's `/` menu stays the
// authority: a command here proves only that a file is where Claude Code
// looks. Read with the rules of Claude Code 2.1.314; CLAUDE_CONFIG_DIR, managed
// settings, synced claude.ai skills and project plugin settings are not read.
import { Array, Context, Effect, Layer, Match, Option, Order, pipe, Schema as S, String } from "effect"
import { Hc } from "../../hc/Hc.ts"
import type { SlashCommand } from "../../shared/SlashCommand.ts"
import { localOf } from "../HerdrApp.ts"

/** The scan failed: hc could not run it, or it ran too long. */
export class CommandsError extends S.TaggedError<CommandsError, { readonly brand: unique symbol }>()("CommandsError", {
  message: S.String,
}) {}

export class ClaudeCommands extends Context.Service<ClaudeCommands>()("herdr-web/server/claude/ClaudeCommands", {
  make: Effect.gen(function* () {
    const hc = yield* Hc

    const scan = (on: Option.Option<string>, cwd: Option.Option<string>, script: "own" | "plugins", args: ReadonlyArray<string>) =>
      hc.exec({ argv: scanArgv(script, args), cwd, on, timeout: Option.some(SCAN_TIMEOUT) }).pipe(
        Effect.mapError((error) => new CommandsError({ message: error.message })),
        Effect.flatMap(({ timed_out, stdout }) =>
          timed_out ? Effect.fail(new CommandsError({ message: "reading the commands took too long" })) : Effect.succeed(parseRecords(stdout)),
        ),
      )

    return {
      /** The commands for the agent in `terminal`, read from its folder on its machine. */
      list: (terminal: string, cwd: string) =>
        Effect.gen(function* () {
          const { on } = localOf(terminal)
          const records = yield* scan(on, Option.some(cwd), "own", [])
          const settings = settingsOf(records)
          const plugins = pluginsOf(records, settings)
          const pluginRecords = Array.isReadonlyArrayNonEmpty(plugins)
            ? yield* scan(on, Option.none(), "plugins", Array.flatMap(plugins, ({ name, path }) => [name, path]))
            : []
          return commandsOf([...records, ...pluginRecords], settings)
        }),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

/** The program that runs a scan: the shell, with the prelude, the script, and its arguments. */
export const scanArgv = (script: "own" | "plugins", args: ReadonlyArray<string>) => ["sh", "-c", `${PRELUDE}\n${script === "own" ? OWN_SCRIPT : PLUGIN_SCRIPT}`, "sh", ...args]

/**
 * The built-in commands the composer offers, as Claude Code 2.1.314 names
 * them: the ones that act on their own, or with what is typed after them.
 * The ones that open a picker or a panel need the terminal.
 */
export const BUILT_INS: ReadonlyArray<SlashCommand> = Array.map(
  [
    ["clear", "Clear the conversation and start a new one", Option.none()],
    ["compact", "Summarise the conversation to free context", Option.some("[instructions]")],
    ["context", "Show what fills the context window", Option.none()],
    ["init", "Write a CLAUDE.md file with the codebase's documentation", Option.none()],
    ["model", "Set the model", Option.some("[model]")],
    ["review", "Review the current diff or a pull request", Option.none()],
  ] as const,
  ([name, description, hint]) => ({ name, description, hint, origin: "built-in" }),
)

const RecordKind = S.Literals(["skill", "command", "json"])

/** One file the scan read: what it holds, where it was, and its frontmatter and first lines. */
export type ScanRecord = Readonly<{ kind: typeof RecordKind.Type; origin: string; prefix: string; root: string; path: string; text: string }>

/**
 * Reads the scan's output: each file starts with a header line after an
 * RS byte, its fields split by tabs.
 */
export const parseRecords = (stdout: string): ReadonlyArray<ScanRecord> =>
  Array.getSomes(
    Array.map(Array.drop(String.split(stdout, RECORD), 1), (chunk) => {
      const [header, ...lines] = String.split(chunk, "\n")
      const fields = String.split(header ?? "", "\t")
      return fields.length !== 5
        ? Option.none()
        : Option.map(S.decodeUnknownOption(RecordKind)(fields[0]), (kind) => ({ kind, origin: fields[1] ?? "", prefix: fields[2] ?? "", root: fields[3] ?? "", path: fields[4] ?? "", text: lines.join("\n") }))
    }),
  )

/**
 * The commands, in the order Claude Code lets one name win: skills before
 * command files, the user's before the project's, then the plugins'. A
 * skill or file of a built-in's name replaces the built-in.
 */
export const commandsOf = (records: ReadonlyArray<ScanRecord>, settings: Settings): ReadonlyArray<SlashCommand> => {
  const off = (name: string) => Option.exists(Option.fromNullishOr(settings.skillOverrides?.[name]), (state) => state === "off")
  const found = Array.getSomes(
    Array.map(
      Array.sort(
        Array.filter(records, ({ kind }) => kind !== "json"),
        RANK,
      ),
      commandOf,
    ),
  )
  const shown = Array.filter(found, ({ command, isPlugin }) => isPlugin || (!off(command.name) && !String.startsWith("anthropic-skills")(String.toLowerCase(command.name))))
  return Array.dedupeWith([...Array.map(shown, ({ command }) => command), ...BUILT_INS], (a, b) => a.name === b.name)
}

/** The parts of the user's settings.json the scan uses. */
export const Settings = S.Struct({
  enabledPlugins: S.optionalKey(S.Record(S.String, S.Boolean)),
  skillOverrides: S.optionalKey(S.Record(S.String, S.String)),
})
export type Settings = typeof Settings.Type

const InstalledPlugins = S.Struct({
  plugins: S.Record(S.String, S.Array(S.Struct({ installPath: S.String }))),
})

/** The frontmatter fields a command's file may set; others are left alone. */
const Frontmatter = S.Struct({
  name: S.optionalKey(S.String),
  description: S.optionalKey(S.String),
  "argument-hint": S.optionalKey(S.String),
  "user-invocable": S.optionalKey(S.Union([S.Boolean, S.Finite, S.String])),
})

const NO_FIELDS: typeof Frontmatter.Type = {}

const settingsOf = (records: ReadonlyArray<ScanRecord>): Settings =>
  Option.getOrElse(jsonOf(records, "/.claude/settings.json", Settings), () => ({}))

/** The plugins settings.json turns on, each with the folder it is installed in. */
const pluginsOf = (records: ReadonlyArray<ScanRecord>, settings: Settings) =>
  Option.match(jsonOf(records, "/.claude/plugins/installed_plugins.json", InstalledPlugins), {
    onNone: () => [],
    onSome: ({ plugins }) =>
      Array.getSomes(
        Array.map(
          Array.filter(Object.entries(settings.enabledPlugins ?? {}), ([, isOn]) => isOn),
          ([id]) =>
            Option.map(
              Option.flatMap(Option.fromNullishOr(plugins[id]), Array.head),
              ({ installPath }) => ({ name: Option.getOrElse(Array.head(String.split(id, "@")), () => id), path: installPath }),
            ),
        ),
      ),
  })

const jsonOf = <S extends S.Top & { readonly DecodingServices: never }>(records: ReadonlyArray<ScanRecord>, ending: string, schema: S) =>
  Option.flatMap(
    Array.findFirst(records, ({ kind, path }) => kind === "json" && String.endsWith(ending)(path)),
    ({ text }) => S.decodeOption(S.fromJsonString(schema))(text),
  )

const commandOf = (record: ScanRecord) => {
  const { fields, body } = frontmatterOf(record.text)
  const isHidden = Option.exists(Option.fromNullishOr(fields["user-invocable"]), isOff)
  const folder = Option.getOrElse(Array.last(Array.dropRight(String.split(record.path, "/"), 1)), () => "")
  const own =
    record.kind === "skill"
      ? Option.getOrElse(Option.filter(Option.fromNullishOr(fields.name), (name) => /^[\p{L}\p{N}_:-]+$/u.test(name)), () => folder)
      : pipe(record.path.slice(record.root.length + 1), String.replace(/\.md$/, ""), String.replaceAll("/", ":"))
  const description = Option.getOrElse(
    Option.orElse(Option.filter(Option.map(Option.fromNullishOr(fields.description), String.trim), String.isNonEmpty), () =>
      Array.findFirst(Array.map(String.split(body, "\n"), String.trim), String.isNonEmpty),
    ),
    () => "",
  )
  return isHidden || String.isEmpty(own) || (record.kind === "skill" && record.origin !== "plugin" && String.toLowerCase(folder) === "synced")
    ? Option.none()
    : Option.some({
        isPlugin: record.origin === "plugin",
        command: {
          name: String.isEmpty(record.prefix) ? own : `${record.prefix}:${own}`,
          description,
          hint: Option.filter(Option.map(Option.fromNullishOr(fields["argument-hint"]), String.trim), String.isNonEmpty),
          origin: record.origin === "plugin" ? "plugin" : record.origin === "project" ? "project" : "user",
        } satisfies SlashCommand,
      })
}

/** Frontmatter booleans take yes, no, on, off, 1 and 0 in any case. */
const isOff = Match.type<boolean | number | string>().pipe(
  Match.when(Match.boolean, (value) => !value),
  Match.when(Match.number, (value) => value === 0),
  Match.orElse((value) => ["false", "no", "off", "0"].includes(String.toLowerCase(String.trim(value)))),
)

/** A file's YAML frontmatter, when it starts with one, and the text after it. */
export const frontmatterOf = (text: string) =>
  Option.match(Option.fromNullishOr(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)), {
    onNone: () => ({ fields: NO_FIELDS, body: text }),
    onSome: ([whole, yaml = ""]) => ({
      fields: Option.getOrElse(
        Option.flatMap(
          Option.liftThrowable(() => Bun.YAML.parse(yaml))(),
          S.decodeUnknownOption(Frontmatter),
        ),
        () => NO_FIELDS,
      ),
      body: text.slice(whole.length),
    }),
  })

// Skills, then command files: the user's, then the project's from the nearest folder up; then the plugins' skills and command files.
const RANK = Order.mapInput(Order.Number, ({ kind, origin }: ScanRecord) => (origin === "plugin" ? 4 : 0) + (kind === "skill" ? 0 : 2) + (origin === "project" ? 1 : 0))

const RECORD = "\u001e"

/** Seconds a scan may run. */
const SCAN_TIMEOUT = 10

/**
 * The scan's shell functions. `put` prints a file's header, then its
 * frontmatter and the first line after it, which is all a command needs.
 */
const PRELUDE = String.stripMargin(`|put() { printf '\\036%s\\t%s\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3" "$4" "$5"; awk 'NR==1 && $0=="---" {f=1; print; next} f {print; if ($0=="---") f=0; next} NF {print; exit}' "$5"; }
  |skills() { for f in "$3"/*/SKILL.md; do [ -f "$f" ] && put skill "$1" "$2" "$3" "$f"; done; }
  |commands() { [ -d "$3" ] && find -L "$3" -type f -name '*.md' | sort | while IFS= read -r f; do put command "$1" "$2" "$3" "$f"; done; }`)

/**
 * The user's skills, commands and settings, then the project's from the
 * agent's folder up to its repository's root; a folder in no repository
 * gives only its own. Never home or above it: those are the user's.
 */
const OWN_SCRIPT = String.stripMargin(`|c="$HOME/.claude"
  |skills user "" "$c/skills"; commands user "" "$c/commands"
  |for f in "$c/settings.json" "$c/plugins/installed_plugins.json"; do [ -f "$f" ] && { printf '\\036json\\t\\t\\t\\t%s\\n' "$f"; cat "$f"; }; done
  |[ "$PWD" = / ] && exit 0
  |case "$HOME/" in "$PWD"/*) exit 0;; esac
  |d=$PWD; dirs=
  |while :; do
  |  dirs="$dirs$d
  |"
  |  [ -e "$d/.git" ] && break
  |  p=$(dirname "$d")
  |  if [ "$p" = "$HOME" ] || [ "$p" = "$d" ]; then dirs="$PWD
  |"; break; fi
  |  d=$p
  |done
  |printf '%s' "$dirs" | while IFS= read -r d; do skills project "" "$d/.claude/skills"; commands project "" "$d/.claude/commands"; done`)

/** Each turned-on plugin's skills and commands; its arguments are pairs of plugin name and folder. */
const PLUGIN_SCRIPT = String.stripMargin(`|while [ $# -ge 2 ]; do skills plugin "$1" "$2/skills"; commands plugin "$1" "$2/commands"; shift 2; done`)
