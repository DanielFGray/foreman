// A slash command an agent takes, as the composer suggests it.
import { Schema as S } from "effect"

export const SlashCommand = S.Struct({
  /** Typed after the slash: `compact`, `review-pr`, `frontend-design:frontend-design`. */
  name: S.String,
  /** Empty when the file gives none. */
  description: S.String,
  /** What the command takes after its name, such as `<file>`. */
  hint: S.Option(S.String),
  /**
   * Built into the agent; a file in the user's, the project's or a plugin's
   * folder, as Claude Code reads them; or listed by the agent's own server, as
   * OpenCode lists its config commands and MCP prompts.
   */
  origin: S.Literals(["built-in", "user", "project", "plugin", "server"]),
})
export type SlashCommand = typeof SlashCommand.Type
