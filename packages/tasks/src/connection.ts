import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Layer } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, MIGRATIONS_TABLE } from "./migrations.ts";

/**
 * One connection to the store at `filename`, migrated before anything reads it.
 *
 * Every service in this package shares it, so a file is opened once per process
 * and the migrations run once per open.
 */
export const connectionAt = (filename: string) =>
  Layer.effectDiscard(SqliteMigrator.run({ loader: MIGRATIONS, table: MIGRATIONS_TABLE })).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename, busyTimeout: "5 seconds" })),
  );

/** The task store's file: `PROG_DB`, else `~/.prog/prog.db`, as the Go `prog` resolves it. */
export const storePath = (): string => process.env.PROG_DB ?? join(homedir(), ".prog", "prog.db");
