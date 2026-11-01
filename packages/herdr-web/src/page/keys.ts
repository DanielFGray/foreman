// The soft keys under a pane: the keys a phone's keyboard lacks. Ctrl and alt
// stay armed until the next key, whether that is a soft key or a key typed
// into a live terminal.
import { Array, Effect, Match, Option, Record, Result, Schema as S, String } from "effect"
import * as Mount from "foldkit/mount"

export const Modifiers = S.Struct({ ctrl: S.Boolean, alt: S.Boolean })
export type Modifiers = typeof Modifiers.Type

export const Modifier = S.Literals(["ctrl", "alt"])
export type Modifier = typeof Modifier.Type

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false }

/** A soft key: one hc presses, by its hc name such as `ctrl+c`, or a modifier for the next key. */
export const SoftKey = S.Union([
  S.TaggedStruct("Press", { key: S.String }),
  S.TaggedStruct("Hold", { modifier: Modifier }),
])
export type SoftKey = typeof SoftKey.Type

const press = (key: string): SoftKey => ({ _tag: "Press", key })
const hold = (modifier: Modifier): SoftKey => ({ _tag: "Hold", modifier })

/** The row a browser shows until its person changes it, in the order the keys show. */
export const DEFAULT_SOFT_KEYS: ReadonlyArray<SoftKey> = [
  press("esc"),
  press("tab"),
  hold("ctrl"),
  hold("alt"),
  press("left"),
  press("up"),
  press("down"),
  press("right"),
  press("enter"),
  press("ctrl+c"),
  press("y"),
  press("n"),
]

/** What a key's chip shows: arrows and Enter as symbols, ctrl with one character as `^C`, else the hc name. */
export const keyLabel = (name: string): string => {
  const parts = String.split(name, "+")
  const base = Option.getOrElse(Array.last(parts), () => name)
  const modifiers = parts.slice(0, -1)
  const shown = Option.getOrElse(Record.get(BASE_LABELS, base), () => (/^f\d+$/.test(base) ? base.toUpperCase() : base))
  return modifiers.length === 1 && modifiers[0] === "ctrl" && base.length === 1 ? `^${base.toUpperCase()}` : [...modifiers, shown].join("+")
}

// SEND KEYS SHEET
// It offers only what hc can encode (herdr-core's keys.rs): these modifiers,
// its named keys, F1–F12, and one character of its set.

export const SheetModifier = S.Literals(["ctrl", "alt", "shift", "super"])
export type SheetModifier = typeof SheetModifier.Type

export const SheetModifiers = S.Struct({ ctrl: S.Boolean, alt: S.Boolean, shift: S.Boolean, super: S.Boolean })
export type SheetModifiers = typeof SheetModifiers.Type

export const NO_SHEET_MODIFIERS: SheetModifiers = { ctrl: false, alt: false, shift: false, super: false }

/** The named keys the sheet offers, with the words its buttons show. */
export const NAMED_KEYS: ReadonlyArray<readonly [name: string, label: string]> = [
  ["esc", "Esc"],
  ["tab", "Tab"],
  ["enter", "Enter"],
  ["backspace", "Backspace"],
  ["space", "Space"],
  ["up", "↑"],
  ["down", "↓"],
  ["left", "←"],
  ["right", "→"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PgUp"],
  ["pagedown", "PgDn"],
  ["insert", "Ins"],
  ["delete", "Del"],
]

export const F_KEYS: ReadonlyArray<string> = Array.makeBy(12, (index) => `f${index + 1}`)

/** One typed character as hc names it, or why hc cannot send it. */
export const characterKey = (text: string): Result.Result<string, string> =>
  /^[a-z0-9`\\[\],=\-.';/]$/.test(text)
    ? Result.succeed(text)
    : /^[A-Z]$/.test(text)
      ? Result.fail(`Type ${text.toLowerCase()} and turn on Shift.`)
      : String.isEmpty(text)
        ? Result.fail("Type one character.")
        : Result.fail(`hc cannot send ${text}; it takes a letter, a digit, or one of \` \\ [ ] , = - . ' ; /`)

/** The key with the armed modifiers, as hc names it: `ctrl+alt+left`. */
export const withModifiers = (key: string, { ctrl, alt }: Modifiers) =>
  [...(ctrl ? ["ctrl"] : []), ...(alt ? ["alt"] : []), key].join("+")

/**
 * A key typed into a terminal with the armed modifiers applied, in the bytes a
 * terminal sends: ctrl maps a letter to its control code, alt sends ESC first.
 * None when nothing is armed or the input is not one key, such as a paste.
 */
export const applyModifiers = (data: string, { ctrl, alt }: Modifiers): Option.Option<string> =>
  (ctrl || alt) && data.length === 1
    ? Option.map(ctrl ? controlCode(data) : Option.some(data), (key) => (alt ? `\u001b${key}` : key))
    : Option.none()

/** The armed modifiers as the `data-modifiers` attribute the view writes on a terminal. */
export const modifiersAttribute = ({ ctrl, alt }: Modifiers) =>
  [...(ctrl ? ["ctrl"] : []), ...(alt ? ["alt"] : [])].join(" ")

export const parseModifiersAttribute = (attribute: string): Modifiers => {
  const words = attribute.split(" ")
  return { ctrl: words.includes("ctrl"), alt: words.includes("alt") }
}

export const CompletedKeepTypingFocus = S.TaggedStruct("CompletedKeepTypingFocus", {})

/**
 * Keeps the focus where it is when a key in the element is pressed: a tap on
 * a soft key would otherwise move the focus off the terminal or prompt and
 * close the phone's keyboard. The click still fires.
 */
export const KeepTypingFocus = Mount.define("KeepTypingFocus", {
  messages: [CompletedKeepTypingFocus],
  execute: ({ element }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const keep = (event: Event) => event.preventDefault()
        element.addEventListener("mousedown", keep)
        return keep
      }),
      (keep) => Effect.sync(() => element.removeEventListener("mousedown", keep)),
    ).pipe(Effect.as(CompletedKeepTypingFocus.make({}))),
})

// Ctrl with a letter or one of @[\]^_ gives that character's code less 64;
// ctrl with space gives NUL and with ? gives DEL, as a terminal keyboard does.
const controlCode = (key: string): Option.Option<string> =>
  Match.value(key.toUpperCase()).pipe(
    Match.when(" ", () => Option.some("\u0000")),
    Match.when("?", () => Option.some("\u007f")),
    Match.orElse((upper) =>
      Option.map(
        Option.liftPredicate(upper.charCodeAt(0), (code) => code >= 64 && code <= 95),
        (code) => globalThis.String.fromCharCode(code - 64),
      ),
    ),
  )

const BASE_LABELS: Readonly<Record<string, string>> = { left: "←", up: "↑", down: "↓", right: "→", enter: "⏎" }
