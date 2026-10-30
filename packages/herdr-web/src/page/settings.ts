// The look this browser keeps for itself: a phone and a desk want different
// sizes, so settings stay on the device, in its local storage.
import { BrowserKeyValueStore } from "@effect/platform-browser"
import { Effect, Match, Number, Option, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"

/** Where text appears; a terminal needs a monospaced font. */
export const Surface = Schema.Literals(["chat", "terminal"])
export type Surface = typeof Surface.Type

export const TextStyle = Schema.Struct({
  /** None is the surface's fallback font. */
  font: Schema.OptionFromNullOr(Schema.String),
  size: Schema.Int,
})
export type TextStyle = typeof TextStyle.Type

export const Settings = Schema.Struct({ chat: TextStyle, terminal: TextStyle })
export type Settings = typeof Settings.Type

export const DEFAULT_SETTINGS: Settings = {
  chat: { font: Option.none(), size: 14 },
  terminal: { font: Option.none(), size: 13 },
}

export const MIN_SIZE = 8
export const MAX_SIZE = 28

/** The settings with one surface's style changed. */
export const restyle = (settings: Settings, surface: Surface, change: (style: TextStyle) => TextStyle): Settings =>
  Match.value(surface).pipe(
    Match.when("chat", () => ({ ...settings, chat: change(settings.chat) })),
    Match.when("terminal", () => ({ ...settings, terminal: change(settings.terminal) })),
    Match.exhaustive,
  )

export const stepSize = (style: TextStyle, step: number): TextStyle => ({
  ...style,
  size: Number.clamp(style.size + step, { minimum: MIN_SIZE, maximum: MAX_SIZE }),
})

/** The saved settings, or the defaults when there are none or storage is closed to the page (a private window). */
export const loadSettings = Effect.gen(function* () {
  const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, Settings)
  return Option.getOrElse(yield* store.get(STORAGE_KEY), () => DEFAULT_SETTINGS)
}).pipe(
  Effect.catchTags({
    KeyValueStoreError: (error) => Effect.logWarning("the saved settings cannot be read", error).pipe(Effect.as(DEFAULT_SETTINGS)),
    SchemaError: (error) => Effect.logWarning("the saved settings are from another version", error).pipe(Effect.as(DEFAULT_SETTINGS)),
  }),
  Effect.provide(BrowserKeyValueStore.layerLocalStorage),
)

export const saveSettings = (settings: Settings) =>
  Effect.gen(function* () {
    const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, Settings)
    yield* store.set(STORAGE_KEY, settings)
  }).pipe(Effect.provide(BrowserKeyValueStore.layerLocalStorage))

/** A CSS font-family list: the chosen font first, then the surface's fallback. */
export const fontStack = (surface: Surface, maybeFont: Option.Option<string>) =>
  Option.match(maybeFont, { onNone: () => FALLBACK[surface], onSome: (font) => `${JSON.stringify(font)}, ${FALLBACK[surface]}` })

const FALLBACK = { chat: "system-ui, sans-serif", terminal: "ui-monospace, monospace" } satisfies Record<Surface, string>

const STORAGE_KEY = "herdr-web.settings"
