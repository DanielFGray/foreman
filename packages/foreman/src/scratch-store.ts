import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { connectionAt } from "tasks";

/**
 * A task store in a temporary file, for tests: the migration makes the schema,
 * so a test seeds rows and never restates a table.
 *
 * `layer` is one connection per use of the layer; `cleanup` removes the file.
 */
export const scratchStore = () => {
  const directory = mkdtempSync(join(tmpdir(), "foreman-store-"));
  const file = join(directory, "store.db");
  return {
    file,
    layer: connectionAt(file),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};

/**
 * Runs a SQL script of plain statements. A statement ends at a semicolon at the
 * end of a line, and a line starting with \`--\` is a comment.
 */
export const seed = (script: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements = script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    yield* Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true });
  });

/** Runs `effect` on a fresh scratch store seeded with `script`, then removes the file. */
export const withStore = <A, E>(
  script: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> => {
  const store = scratchStore();
  return seed(script)
    .pipe(Effect.andThen(effect), Effect.provide(store.layer), Effect.runPromise)
    .finally(store.cleanup);
};
