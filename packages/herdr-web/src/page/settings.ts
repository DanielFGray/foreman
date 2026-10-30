// The look this browser keeps for itself: a phone and a desk want different
// sizes, so settings stay on the device, in its local storage.
import { Effect, Match, Number, Option, Schema as S } from "effect"
import { loadStored, saveStored } from "./stored.ts"

/** Where text appears; a terminal needs a monospaced font. */
export const Surface = S.Literals(["chat", "terminal"])
export type Surface = typeof Surface.Type

export const TextStyle = S.Struct({
  /** None is the surface's fallback font. */
  font: S.OptionFromNullOr(S.String),
  size: S.Int,
})
export type TextStyle = typeof TextStyle.Type

/** Where the sidebar lists agents: in one list below the spaces, or under the space that holds each. */
export const AgentList = S.Literals(["below", "nested"])
export type AgentList = typeof AgentList.Type

/**
 * The view an agent's pane opens in when it comes on screen: the one last
 * picked for that run of the agent, the one last picked in its space, or the
 * chat. See openingView.ts.
 */
export const AgentView = S.Literals(["run", "space", "chat"])
export type AgentView = typeof AgentView.Type

export const Settings = S.Struct({
  chat: TextStyle,
  terminal: TextStyle,
  // Settings saved before this choice existed keep their fonts.
  agents: AgentList.pipe(S.withDecodingDefaultKey(Effect.succeed("below"))),
  agentView: AgentView.pipe(S.withDecodingDefaultKey(Effect.succeed("run"))),
})
export type Settings = typeof Settings.Type

export const DEFAULT_SETTINGS: Settings = {
  chat: { font: Option.none(), size: 14 },
  terminal: { font: Option.none(), size: 13 },
  agents: "below",
  agentView: "run",
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

const STORAGE_KEY = "herdr-web.settings"

export const loadSettings = loadStored(STORAGE_KEY, Settings, DEFAULT_SETTINGS)

export const saveSettings = (settings: Settings) => saveStored(STORAGE_KEY, Settings, settings)

/** A CSS font-family list: the chosen font first, then the surface's fallback. */
export const fontStack = (surface: Surface, maybeFont: Option.Option<string>) =>
  Option.match(maybeFont, { onNone: () => FALLBACK[surface], onSome: (font) => `${JSON.stringify(font)}, ${FALLBACK[surface]}` })

const FALLBACK = { chat: "system-ui, sans-serif", terminal: "ui-monospace, monospace" } satisfies Record<Surface, string>

