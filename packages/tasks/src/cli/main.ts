#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { store, Tasks } from "tasks";
import { tasksCommand } from "./commands.ts";

/**
 * The `tasks` program. A refused command prints one line and exits 1; the
 * store's errors are the ones a caller can cause, so none prints a stack.
 */
const program = tasksCommand.pipe(
  Command.provide(Tasks.layerSql.pipe(Layer.provide(store))),
  Command.run({ version: "0.1.0" }),
);

BunRuntime.runMain(
  program.pipe(
    Effect.catchTags({
      TaskError: (error) => fail(`${error.id}: ${error.detail}`),
      SqlError: (error) => fail(`store: ${error.message}`),
    }),
    Effect.provide(BunServices.layer),
  ),
);

function fail(line: string) {
  return Console.error(`error: ${line}`).pipe(
    Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
  );
}
