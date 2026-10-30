// A slash command an agent takes, as the composer suggests it.
import { Schema } from "effect"

export const SlashCommand = Schema.Struct({
  /** Typed after the slash: `compact`, `review-pr`, `frontend-design:frontend-design`. */
  name: Schema.String,
  /** Empty when the file gives none. */
  description: Schema.String,
  /** What the command takes after its name, such as `<file>`. */
  hint: Schema.Option(Schema.String),
  /**
   * Built into the agent; a file in the user's, the project's or a plugin's
   * folder, as Claude Code reads them; or listed by the agent's own server, as
   * OpenCode lists its config commands and MCP prompts.
   */
  origin: Schema.Literals(["built-in", "user", "project", "plugin", "server"]),
})
export type SlashCommand = typeof SlashCommand.Type
