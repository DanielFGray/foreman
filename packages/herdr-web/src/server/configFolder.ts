import { Config } from "effect"

/** The bridge's own config folder, which only the user may read: its sign-ins and push keys live there. */
export const ConfigFolder = Config.String("XDG_CONFIG_HOME").pipe(
  Config.orElse(() => Config.String("HOME").pipe(Config.map((home) => `${home}/.config`))),
  Config.map((config) => `${config}/herdr-web`),
)
