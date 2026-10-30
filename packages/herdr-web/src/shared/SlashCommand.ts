// A slash command a Claude Code agent takes, as the composer suggests it.
import { Schema } from "effect"

export const SlashCommand = Schema.Struct({
  /** Typed after the slash: `compact`, `review-pr`, `frontend-design:frontend-design`. */
  name: Schema.String,
  /** Empty when the file gives none. */
  description: Schema.String,
  /** What the command takes after its name, such as `<file>`. */
  hint: Schema.Option(Schema.String),
  /** Built into Claude Code, or a file in the user's, the project's or a plugin's folder. */
  origin: Schema.Literals(["built-in", "user", "project", "plugin"]),
})
export type SlashCommand = typeof SlashCommand.Type
