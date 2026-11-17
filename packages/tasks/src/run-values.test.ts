/**
 * The stored schema's CHECK lists against the lists writers validate with.
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAt } from "./connection.ts";
import { DEFECT_KINDS, OUTCOMES, WORK } from "./run-values.ts";

const dir = mkdtempSync(join(tmpdir(), "tasks-run-values-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The quoted words of `CHECK (<column> IN (...))` in a table's stored SQL. Line
 * comments are dropped first: the defects list explains each kind in one.
 */
const checkList = (sql: string, column: string): ReadonlyArray<string> => {
  const code = sql.replaceAll(/--[^\n]*/g, "");
  const list = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`).exec(code)?.[1] ?? "";
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
};

test("a migrated store accepts exactly the run values writers validate with", async () => {
  const file = join(dir, "tasks.db");
  await Effect.runPromise(Effect.void.pipe(Effect.provide(connectionAt(file))));
  const sqlite = new Database(file, { readonly: true });
  try {
    const sqlOf = (table: string) =>
      sqlite
        .query<{ sql: string }, [string]>(`SELECT sql FROM sqlite_master WHERE name = ?`)
        .get(table)!.sql;
    expect(checkList(sqlOf("runs"), "work")).toEqual([...WORK]);
    expect(checkList(sqlOf("runs"), "outcome")).toEqual([...OUTCOMES]);
    expect(checkList(sqlOf("defects"), "kind")).toEqual([...DEFECT_KINDS]);
  } finally {
    sqlite.close();
  }
});
