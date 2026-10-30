// OpenCode's database, which the bridge reads with `sqlite3` on the agent's
// machine. Its tables are OpenCode's own, not a published interface: a change
// to them shows as a chat that cannot be read, not as wrong entries.

/**
 * A shell script that prints the database's path, by OpenCode's rule
 * (packages/cli/src/database-path.ts): `OPENCODE_DB`, taken from OpenCode's
 * data folder when relative, else `opencode.db` there. hc runs it with hc's
 * environment, so an agent started with another `OPENCODE_DB` is not found.
 */
export const DATABASE_PATH = `data="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode"; file="\${OPENCODE_DB:-opencode.db}"; case "$file" in /*) printf %s "$file" ;; *) printf %s "$data/$file" ;; esac`

/** `text` as an SQL string literal. */
export const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`
