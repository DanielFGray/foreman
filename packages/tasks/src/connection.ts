/**
 * The SQLite connection to the task store, migrated on open.
 */
import { BunServices } from "@effect/platform-bun";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Config, Effect, Layer, Option, Path } from "effect";
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

/**
 * The task store's file: `TASKS_DB` when set, else `$HOME/.tasks/tasks.db`.
 * Unset `HOME` with no `TASKS_DB` is a typed config failure, not a silent path.
 */
export const storePath: Effect.Effect<string, Config.ConfigError, Path.Path> = Effect.gen(
  function* () {
    const path = yield* Path.Path;
    return yield* Option.match(yield* Config.option(Config.String("TASKS_DB")), {
      onSome: Effect.succeed,
      onNone: () =>
        Config.String("HOME").pipe(Effect.map((home) => path.join(home, ".tasks", "tasks.db"))),
    });
  },
);

/**
 * The store's connection. `Layer.suspend` re-reads `TASKS_DB` each time a
 * process builds the layer, so a test that points `TASKS_DB` at a scratch file
 * gets that file. BunServices supplies Path and ConfigProvider for the read.
 */
export const store = Layer.suspend(() =>
  Layer.unwrap(Effect.map(storePath, connectionAt).pipe(Effect.provide(BunServices.layer))),
);
