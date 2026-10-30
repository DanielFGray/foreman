// The soft keys under a pane: the keys a phone's keyboard lacks. Ctrl and alt
// stay armed until the next key, whether that is a soft key or a key typed
// into a live terminal.
import { Effect, Match, Option, Schema } from "effect"
import * as Mount from "foldkit/mount"

export const Modifiers = Schema.Struct({ ctrl: Schema.Boolean, alt: Schema.Boolean })
export type Modifiers = typeof Modifiers.Type

export const Modifier = Schema.Literals(["ctrl", "alt"])
export type Modifier = typeof Modifier.Type

export const NO_MODIFIERS: Modifiers = { ctrl: false, alt: false }

/** A soft key: one hc presses, by its hc name, or a modifier for the next key. */
export type SoftKey = Readonly<{ _tag: "Press"; key: string; label: string }> | Readonly<{ _tag: "Hold"; modifier: Modifier }>

const press = (key: string, label = key): SoftKey => ({ _tag: "Press", key, label })
const hold = (modifier: Modifier): SoftKey => ({ _tag: "Hold", modifier })

/** In the order they show. */
export const SOFT_KEYS: ReadonlyArray<SoftKey> = [
  press("esc"),
  press("tab"),
  hold("ctrl"),
  hold("alt"),
  press("left", "←"),
  press("up", "↑"),
  press("down", "↓"),
  press("right", "→"),
  press("enter", "⏎"),
  press("ctrl+c", "^C"),
  press("y"),
  press("n"),
]

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

export const CompletedKeepTypingFocus = Schema.TaggedStruct("CompletedKeepTypingFocus", {})

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
        (code) => String.fromCharCode(code - 64),
      ),
    ),
  )
